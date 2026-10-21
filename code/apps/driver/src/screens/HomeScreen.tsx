import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { asRideId } from '@babana/navigation';
import { MapView, type LatLng, type MapMarker } from '@babana/maps';
import type { ConnectionState } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { AvailabilityToggle } from '../components/AvailabilityToggle';
import { getCurrentPosition } from '../location';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { isProposalHandled, markProposalHandled } from '../proposalDedup';
import { consumePendingProposalNavigation } from '../push/handlers';
import type { DriverParamList } from '../navigation/types';

/**
 * Écran d'accueil (L6-11) : l'écran permanent de l'app Chauffeur (`navigation/types.ts`), que
 * les événements interrompent -- proposition reçue (L6-12), course en cours (L6-13). Il porte
 * donc deux responsabilités : la bascule en ligne/hors ligne elle-même, et l'écoute des messages
 * qui font quitter cet écran (`proposal.new`, et `session.synced.activeProposal` -- une
 * proposition retrouvée après reconnexion ou relance, L7-04), puisque `Proposal` n'a pas d'autre
 * point d'entrée depuis l'app.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Home'>;

// Centre de la carte tant que la position du chauffeur n'est pas connue (ou refusée) -- même
// repère que l'app Client : jamais un écran vide, jamais une position inventée pour le chauffeur
// (le repère « chauffeur » n'apparaît qu'avec une vraie lecture).
const DOUALA_DEFAULT_CENTER: LatLng = { latitude: 4.0511, longitude: 9.7679 };

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

export function HomeScreen({ navigation }: Props) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  // Lu depuis session.synced (activeRideState), jamais deviné (invariant 3) -- session.resync est
  // déjà envoyé automatiquement à chaque connexion établie, initiale ou après coupure
  // (@babana/api-client/realtime/connection.ts), donc une réponse arrive sans action de cet écran.
  const [inCourse, setInCourse] = useState(false);
  // Position lue une fois à l'ouverture (lecture ponctuelle, `location/oneShot.ts`) -- la capture
  // continue reste celle de `tracker.ts`, cet écran n'y touche pas. `null` : refusée ou
  // indisponible, la carte reste sur le centre par défaut.
  const [position, setPosition] = useState<LatLng | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentPosition().then((fix) => {
      if (!cancelled && fix) setPosition(fix);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    ensureRealtimeConnected();

    // Deux propositions ne peuvent pas s'afficher simultanément (L6-12, critère 5) : si l'écran
    // affiché est déjà Proposal, on n'en ouvre pas un second. Le registre partagé
    // (`proposalDedup`) couvre en plus le cas où le WebSocket et la notification annoncent la
    // même proposition (L7-04, critère 2).
    function alreadyShowingAProposal(): boolean {
      return navigation.getState().routes.some((route) => route.name === 'Proposal');
    }

    function openProposalFromRealtime(params: Extract<DriverParamList['Proposal'], { source?: 'realtime' }>): void {
      if (isProposalHandled(params.rideId) || alreadyShowingAProposal()) return;
      markProposalHandled(params.rideId);
      navigation.navigate('Proposal', params);
    }

    // Démarrage à froid depuis un appui sur la notification, avant que la navigation ne soit
    // prête (`push/handlers.ts`) : la proposition en attente est ouverte ici, une fois montés.
    const pending = consumePendingProposalNavigation();
    if (pending) {
      navigation.navigate('Proposal', {
        source: 'notification',
        rideId: asRideId(pending.rideId),
        expiresAt: pending.expiresAt,
      });
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
        // jamais deux fois sur `onRealtimeMessage`, un abonnement posé au montage de `Proposal`
        // ne le recevrait donc jamais (voir navigation/types.ts). `emittedAt` vient de
        // l'enveloppe -- signalé au serveur à l'affichage réel (`proposal.seen`, L7-04).
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
  }, [navigation]);

  function goToRemittance() {
    navigation.navigate('Remittance');
  }

  const markers: MapMarker[] = position ? [{ id: 'me', kind: 'driver', position }] : [];

  return (
    <View style={styles.container}>
      {/* `key` : la carte ne se recentre pas d'elle-même quand `center` change (région initiale) --
          elle est donc remontée une fois, quand la position arrive. */}
      <MapView
        key={position ? 'located' : 'default'}
        center={position ?? DOUALA_DEFAULT_CENTER}
        markers={markers}
        style={styles.map}
      />

      <View style={styles.statusChip} pointerEvents="none">
        <Text style={styles.connectionState} testID="connection-state">
          {connectionState === 'connected'
            ? 'Connexion au service établie'
            : connectionState === 'connecting'
              ? 'Connexion en cours…'
              : 'Hors connexion'}
        </Text>
      </View>

      {/* Boutons flottants aux deux coins du bas : au pouce, sur une moto, sans quitter la carte
          des yeux (D20). */}
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
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  connectionState: {
    color: '#374151',
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
    minHeight: 48,
    minWidth: 104,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  cashLinkLabel: {
    color: '#374151',
    fontWeight: '600',
    fontSize: 15,
  },
});
