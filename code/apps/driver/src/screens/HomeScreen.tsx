import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { asRideId } from '@babana/navigation';
import { MapView, type LatLng, type MapMarker } from '@babana/maps';
import type { ConnectionState } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { AvailabilityToggle } from '../components/AvailabilityToggle';
import { getCurrentPosition, locationTracker } from '../location';
import { ARRIVAL_RADIUS_METERS, ROUTE_RETRY_COOLDOWN_MS } from '../../config';
import { ProposalPanel } from '../rideFlow/ProposalPanel';
import { ActiveRidePanel, type RideFlowSettings, type RideMapState } from '../rideFlow/ActiveRidePanel';
import { replaceWithSettlement } from '../navigation/transitions';
import { buttonLabels, buttons, cards, colors } from '../theme';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { isProposalHandled, markProposalHandled } from '../proposalDedup';
import { consumePendingProposalNavigation } from '../push/handlers';
import type { ActiveRideParams, DriverParamList, ProposalParams } from '../navigation/types';

/**
 * Écran d'accueil (L6-11) : l'écran permanent de l'app Chauffeur (`navigation/types.ts`) -- la
 * carte, qui ne quitte jamais l'écran pendant une course. Il porte la bascule en ligne/hors ligne,
 * et c'est lui qui héberge tout le déroulé sur cette même carte (`rideFlow/`) :
 *
 *   repos -> proposition (Refuser/Accepter prennent la place des deux boutons flottants)
 *         -> approche (l'itinéraire vers le client s'affiche) -> « Sur place » à proximité
 *         -> « Commencer la course » -> trajet (l'itinéraire vers la destination se charge)
 *         -> « Terminer » -> écran de règlement.
 *
 * L'écoute des messages qui ouvrent une proposition (`proposal.new`, et
 * `session.synced.activeProposal` -- une proposition retrouvée après reconnexion ou relance, L7-04)
 * vit ici ; la notification qui ouvre l'app (`Home: { proposal }`) aboutit au même endroit.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Home'>;

// Centre de la carte tant que la position du chauffeur n'est pas connue (ou refusée) -- même
// repère que l'app Client : jamais un écran vide, jamais une position inventée pour le chauffeur
// (le repère « chauffeur » n'apparaît qu'avec une vraie lecture).
const DOUALA_DEFAULT_CENTER: LatLng = { latitude: 4.0511, longitude: 9.7679 };

type Flow =
  | { kind: 'idle' }
  | { kind: 'proposal'; params: ProposalParams }
  | { kind: 'ride'; ride: ActiveRideParams };

const IDLE: Flow = { kind: 'idle' };

// États de course qui interdisent le passage hors ligne (L3-04, critère 2) -- mêmes valeurs que
// `TOGETHER_STATES` côté Odoo (`babana_ride.py`, cité dans TrackingScreen.tsx côté Client) : un
// chauffeur affecté ou en course est engagé, jamais entre les deux.
const ACTIVE_RIDE_STATES: ReadonlySet<realtime.SessionSyncedMessage['payload']['activeRideState']> = new Set(['assigned', 'in_progress']);

function isSessionSyncedMessage(message: realtime.ServerToClientMessage): message is realtime.SessionSyncedMessage {
  return message.type === 'session.synced';
}

function isProposalNewMessage(message: realtime.ServerToClientMessage): message is realtime.ProposalNewMessage {
  return message.type === 'proposal.new';
}

const RIDE_SETTINGS: RideFlowSettings = {
  arrivalRadiusMeters: ARRIVAL_RADIUS_METERS,
  routeRetryCooldownMs: ROUTE_RETRY_COOLDOWN_MS,
};

export function HomeScreen({ navigation, route }: Props) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  // Lu depuis session.synced (activeRideState), jamais deviné (invariant 3) -- session.resync est
  // déjà envoyé automatiquement à chaque connexion établie, initiale ou après coupure
  // (@babana/api-client/realtime/connection.ts), donc une réponse arrive sans action de cet écran.
  const [inCourse, setInCourse] = useState(false);
  // Dernière position connue : une lecture ponctuelle à l'ouverture, puis les relevés de la capture
  // continue (`tracker.ts`, qui tourne déjà pour le service temps réel -- aucun second GPS). `null` :
  // refusée ou indisponible, la carte reste sur le centre par défaut.
  const [position, setPosition] = useState<LatLng | null>(null);
  const [flow, setFlow] = useState<Flow>(IDLE);
  // Lu de façon synchrone par les gestionnaires de messages (l'effet d'abonnement ne s'exécute
  // qu'une fois) : deux propositions ne s'affichent jamais ensemble (L6-12, critère 5).
  const flowRef = useRef<Flow>(IDLE);
  // Ce que le panneau de course demande à la carte de dessiner (étape + itinéraire).
  const [rideMap, setRideMap] = useState<RideMapState | null>(null);

  const changeFlow = useCallback((next: Flow) => {
    flowRef.current = next;
    setFlow(next);
    if (next.kind !== 'ride') setRideMap(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentPosition().then((fix) => {
      if (!cancelled && fix) setPosition(fix);
    });
    const unsubscribeFix = locationTracker.subscribeFix((fix) => {
      if (!cancelled) setPosition({ latitude: fix.latitude, longitude: fix.longitude });
    });
    return () => {
      cancelled = true;
      unsubscribeFix();
    };
  }, []);

  useEffect(() => {
    ensureRealtimeConnected();

    // Le registre partagé (`proposalDedup`) couvre en plus le cas où le WebSocket et la
    // notification annoncent la même proposition (L7-04, critère 2).
    function openProposal(params: ProposalParams): void {
      if (flowRef.current.kind !== 'idle') return;
      changeFlow({ kind: 'proposal', params });
    }

    function openProposalFromRealtime(params: Extract<ProposalParams, { source?: 'realtime' }>): void {
      if (isProposalHandled(params.rideId) || flowRef.current.kind !== 'idle') return;
      markProposalHandled(params.rideId);
      openProposal(params);
    }

    // Démarrage à froid depuis un appui sur la notification, avant que la navigation ne soit
    // prête (`push/handlers.ts`) : la proposition en attente est ouverte ici, une fois montés.
    const pending = consumePendingProposalNavigation();
    if (pending) {
      openProposal({ source: 'notification', rideId: asRideId(pending.rideId), expiresAt: pending.expiresAt });
    }

    const unsubscribeConnectionState = onRealtimeConnectionStateChange(setConnectionState);

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (isSessionSyncedMessage(message)) {
        // `rideStateKnown: false` -> Odoo était injoignable : l'état de course est indéterminé,
        // on garde celui qu'on a (L7-04, 6 septembre). `activeProposal`, lui, est fiable quel que
        // soit ce drapeau -- il est lu en Redis.
        if (message.payload.rideStateKnown) {
          setInCourse(ACTIVE_RIDE_STATES.has(message.payload.activeRideState));
        }
        // L7-04 : une proposition active retrouvée par resynchronisation (app relancée en pleine
        // proposition, ou reconnexion réseau) -- l'app n'a jamais reçu `proposal.new`, c'est
        // `session.synced` qui la lui apprend, avec sa **véritable** échéance. `null` explicite
        // quand il n'y en a pas : rien à ouvrir, aucune inférence.
        const active = message.payload.activeProposal;
        if (active) {
          openProposalFromRealtime({
            source: 'realtime',
            rideId: asRideId(active.rideId),
            origin: active.origin,
            destination: active.destination,
            amount: active.amount,
            distanceMeters: active.distanceMeters,
            distanceToOriginMeters: active.distanceToOriginMeters,
            expiresAt: active.expiresAt,
            emittedAt: active.emittedAt,
          });
        }
      } else if (isProposalNewMessage(message)) {
        // Le message entier est transmis (pas seulement rideId) : `proposal.new` ne repasse
        // jamais deux fois sur `onRealtimeMessage`. `emittedAt` vient de l'enveloppe -- signalé
        // au serveur à l'affichage réel (`proposal.seen`, L7-04).
        openProposalFromRealtime({
          source: 'realtime',
          rideId: asRideId(message.payload.rideId),
          origin: message.payload.origin,
          destination: message.payload.destination,
          amount: message.payload.amount,
          distanceMeters: message.payload.distanceMeters,
          distanceToOriginMeters: message.payload.distanceToOriginMeters,
          expiresAt: message.payload.expiresAt,
          emittedAt: message.emittedAt,
        });
      }
    });

    return () => {
      unsubscribeConnectionState();
      unsubscribeMessages();
    };
  }, [changeFlow]);

  // Notification touchée app déjà ouverte (`push/handlers.ts` -> `navigate('Home', { proposal })`).
  const notifiedProposal = route.params?.proposal;
  useEffect(() => {
    if (notifiedProposal && flowRef.current.kind === 'idle') {
      changeFlow({ kind: 'proposal', params: notifiedProposal });
    }
  }, [notifiedProposal, changeFlow]);

  const handleAccepted = useCallback(
    (ride: ActiveRideParams) => {
      setInCourse(true);
      changeFlow({ kind: 'ride', ride });
    },
    [changeFlow]
  );
  const handleDismissed = useCallback(() => changeFlow(IDLE), [changeFlow]);
  // Course terminée autrement que par « Terminer » (annulée) : le chauffeur est libre -- sans cela
  // `inCourse`, posé à l'acceptation, resterait vrai et la bascule hors ligne bloquée.
  const handleRideEnded = useCallback(() => {
    setInCourse(false);
    changeFlow(IDLE);
  }, [changeFlow]);
  const handleSettle = useCallback(
    (params: { rideId: ActiveRideParams['rideId']; amount: number }) => replaceWithSettlement(navigation, params),
    [navigation]
  );
  const handleMapState = useCallback((state: RideMapState) => setRideMap(state), []);

  function goToRemittance() {
    navigation.navigate('Remittance');
  }

  const ride = flow.kind === 'ride' ? flow.ride : null;
  const markers: MapMarker[] = [];
  if (position) markers.push({ id: 'me', kind: 'driver', position });
  if (ride && rideMap) {
    markers.push(
      rideMap.stage === 'transit'
        ? { id: 'dropoff', kind: 'dropoff', position: ride.destination }
        : { id: 'pickup', kind: 'pickup', position: ride.origin }
    );
  }
  // Pendant une course la carte est cadrée sur l'itinéraire, pas sur le chauffeur : un centre qui
  // suivrait chaque relevé défairait ce cadrage toutes les quelques secondes.
  const center = ride ? ride.origin : (position ?? DOUALA_DEFAULT_CENTER);

  return (
    <View style={styles.container}>
      <MapView
        center={center}
        markers={markers}
        route={ride && rideMap?.route ? rideMap.route : undefined}
        style={styles.map}
      />

      {flow.kind === 'idle' ? (
        <>
          <View style={styles.statusChip} pointerEvents="none">
            <Text style={styles.connectionState} testID="connection-state">
              {connectionState === 'connected'
                ? 'Connexion au service établie'
                : connectionState === 'connecting'
                  ? 'Connexion en cours…'
                  : 'Hors connexion'}
            </Text>
          </View>

          {/* Boutons flottants aux deux coins du bas : au pouce, sur une moto, sans quitter la
              carte des yeux (D20). Pendant une proposition, Refuser/Accepter prennent leur place. */}
          <View style={styles.floatingToggle} testID="home-floating-toggle">
            <AvailabilityToggle inCourse={inCourse} onNavigateToRemittance={goToRemittance} />
          </View>

          <View style={styles.floatingCash} testID="home-floating-cash">
            <Pressable
              testID="home-go-to-cash"
              accessibilityRole="button"
              onPress={() => navigation.navigate('Cash')}
              style={styles.cashButton}
            >
              <Text style={styles.cashLinkLabel}>Ma caisse</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {flow.kind === 'proposal' ? (
        <ProposalPanel
          // Une autre proposition (autre course) repart d'un panneau neuf.
          key={flow.params.rideId}
          params={flow.params}
          onDismiss={handleDismissed}
          onAccepted={handleAccepted}
        />
      ) : null}

      {flow.kind === 'ride' ? (
        <ActiveRidePanel
          key={flow.ride.rideId}
          ride={flow.ride}
          position={position}
          settings={RIDE_SETTINGS}
          onMapState={handleMapState}
          onSettle={handleSettle}
          onEnded={handleRideEnded}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  statusChip: {
    ...cards.floating,
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  connectionState: {
    color: colors.inkSoft,
    fontWeight: '600',
  },
  floatingToggle: {
    position: 'absolute',
    left: 16,
    bottom: 28,
  },
  floatingCash: {
    position: 'absolute',
    right: 16,
    bottom: 28,
  },
  cashButton: {
    ...buttons.base,
    ...buttons.md,
    ...buttons.secondary,
    ...buttons.floating,
    minWidth: 112,
  },
  cashLinkLabel: {
    ...buttonLabels.base,
    ...buttonLabels.secondary,
  },
});
