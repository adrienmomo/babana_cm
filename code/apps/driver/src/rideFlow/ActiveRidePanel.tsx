import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fetchRoute, reverseGeocode, type LatLng, type MapRoute } from '@babana/maps';
import { ApiError, translateApiError } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';
import { getCurrentPosition } from '../location';
import { CallButton } from '../components/CallButton';
import { EmergencyButton } from '../components/EmergencyButton';
import { SwipeButton } from '../components/SwipeButton';
import { onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { formatDistance } from '../format';
import { isWithinRadius } from './proximity';
import type { ActiveRideParams } from '../navigation/types';
import { cards, colors } from '../theme';

/**
 * Course en cours, côté chauffeur (L6-13, D12) -- un panneau posé sur la carte de Home, qui ne la
 * quitte jamais. Trois temps, chacun une décision humaine du chauffeur (invariant 1 : le nombre
 * d'écritures d'une course est borné par ses décisions, jamais déduit d'une position) :
 *
 * 1. **approche** -- l'itinéraire vers le client s'affiche dès l'acceptation. « Sur place »
 *    n'apparaît qu'à proximité du point de prise en charge (`settings.arrivalRadiusMeters`) ;
 * 2. **sur place** -- « Sur place » prévient le client (`ride.arrived`, temps réel seulement, aucune
 *    écriture Odoo) et fait apparaître « Commencer la course » (HTTP `start`, la vraie décision) ;
 * 3. **trajet** -- l'itinéraire vers la destination se charge tout seul ; « Terminer la course ».
 *
 * **Le chauffeur calcule l'itinéraire, le client reçoit le même** : chaque tracé calculé ici
 * (`fetchRoute`, @babana/maps) est partagé (`route.share`) puis rediffusé tel quel au client
 * (`ride.route`). Le service temps réel n'a aucun routage (D3). Un tracé qui échoue (service
 * injoignable) laisse la carte sans chemin et réessaie à la position suivante -- jamais un chemin
 * inventé. Les tracés ne sont jamais mis en file hors connexion : le dernier est réémis à la
 * reconnexion.
 *
 * Plus de bouton « Google Maps » : l'itinéraire s'affiche sur la carte de l'app elle-même.
 * `session.synced` sert de filet si l'app a été tuée puis relancée en pleine course.
 *
 * **Bouton d'appel du client** (D42, 2 septembre -- amoa/questions/REPONSES-2026-09-02.md §1,
 * referme `amoa/questions/L6-13.md`) : `proposal.accepted` porte désormais `clientPhoneNumber`.
 * Absent, jamais inerte (`CallButton`, même discipline qu'`EmergencyButton`).
 *
 * **La fin de course ne porte que la décision** (J24, `amoa/questions/L6-13.md`) : « Terminer la
 * course » envoie `POST /rides/{id}/complete` **avec un corps vide**. Le relevé du trajet
 * (distance, durée, tracé) vient du service temps réel qui l'a accumulé (L3-10), jamais de l'app
 * -- le stopgap `ride/completion.ts` (ligne droite départ -> arrivée) a disparu avec cet arbitrage.
 *
 * **La fin de course est autorisée hors connexion** (L6-16, spécification) : `handleFinish`
 * passe par `offlineRunner` (`../offline.ts`), jamais `apiClient` directement -- `startRide`, à
 * l'inverse, reste un appel direct : démarrer une course ne fait pas partie des quatre actions
 * que la spécification autorise en file (un départ non confirmé au serveur ne devrait pas rester
 * incertain longtemps). Une fin de course mise en file est rejouée automatiquement à la
 * reconnexion, avec la même clé d'idempotence -- jamais un double `settled`.
 */

export type RideStage = 'approach' | 'arrived' | 'transit';

/** Ce que la carte de Home doit dessiner pour cette course. */
export interface RideMapState {
  stage: RideStage;
  route: MapRoute | null;
}

export interface RideFlowSettings {
  /** Rayon (m) sous lequel « Sur place » apparaît -- config, jamais codé en dur (invariant 5). */
  arrivalRadiusMeters: number;
  /** Délai (ms) avant de redemander un itinéraire qui a échoué. */
  routeRetryCooldownMs: number;
}

export interface ActiveRidePanelProps {
  ride: ActiveRideParams;
  /** Dernière position connue du chauffeur (relevés de la capture continue). */
  position: LatLng | null;
  settings: RideFlowSettings;
  /** La carte de Home dessine ce qui est rapporté ici. Doit être stable entre deux rendus. */
  onMapState: (state: RideMapState) => void;
  onSettle: (params: { rideId: ActiveRideParams['rideId']; amount: number }) => void;
  /** La course s'est terminée autrement que par « Terminer » (annulée) : retour à l'accueil. */
  onEnded: () => void;
}

interface SharedRoute {
  phase: 'approach' | 'transit';
  points: LatLng[];
  distanceMeters: number | null;
  durationSeconds: number | null;
}

function isRideStartedMessage(m: realtime.ServerToClientMessage): m is realtime.RideStartedMessage {
  return m.type === 'ride.started';
}
function isRideCompletedMessage(m: realtime.ServerToClientMessage): m is realtime.RideCompletedMessage {
  return m.type === 'ride.completed';
}
function isRideCancelledMessage(m: realtime.ServerToClientMessage): m is realtime.RideCancelledMessage {
  return m.type === 'ride.cancelled';
}
function isSessionSyncedMessage(m: realtime.ServerToClientMessage): m is realtime.SessionSyncedMessage {
  return m.type === 'session.synced';
}

function formatTripSummary(route: SharedRoute | null): string | null {
  if (!route || route.distanceMeters === null) return null;
  const minutes = route.durationSeconds === null ? null : Math.max(1, Math.round(route.durationSeconds / 60));
  return minutes === null ? formatDistance(route.distanceMeters) : `${formatDistance(route.distanceMeters)} · ≈ ${minutes} min`;
}

export function ActiveRidePanel({ ride, position, settings, onMapState, onSettle, onEnded }: ActiveRidePanelProps) {
  const { rideId, origin, destination, amount, clientPhoneNumber } = ride;

  const [stage, setStage] = useState<RideStage>('approach');
  const [route, setRoute] = useState<SharedRoute | null>(null);
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'starting' | 'finishing'>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  // Fin de course mise en file (réseau absent, L6-16) : distinct de `busy === 'finishing'`, qui
  // ne dure que le temps d'une tentative -- celui-ci peut durer jusqu'à la prochaine
  // reconnexion.
  const [finishQueued, setFinishQueued] = useState(false);

  // Lu de façon synchrone par les gestionnaires de messages -- `stage` (état React) y serait
  // périmé (l'effet d'abonnement ne s'exécute qu'une fois, dépendances [rideId]).
  const stageRef = useRef<RideStage>('approach');
  // La fin de course peut arriver par deux chemins presque simultanés -- la réponse HTTP à
  // `completeRide`, et le message `ride.completed` (L3-19, poussé aussi au chauffeur). Un seul
  // doit conclure.
  const resolvedRef = useRef(false);
  // Itinéraire : la phase pour laquelle un tracé est chargé (ou en cours de chargement), le
  // dernier tracé pour le réémettre à la reconnexion, l'instant du dernier échec (délai avant un
  // nouvel essai), et l'état de montage (une réponse tardive ne touche rien après démontage).
  const routePhaseRef = useRef<'approach' | 'transit' | null>(null);
  const routeRef = useRef<SharedRoute | null>(null);
  const lastRouteFailureAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const phase: 'approach' | 'transit' = stage === 'transit' ? 'transit' : 'approach';

  const enterTransit = useCallback(() => {
    if (stageRef.current === 'transit') return;
    stageRef.current = 'transit';
    setStage('transit');
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    reverseGeocode(origin).then((l) => !cancelled && setOriginLabel(l)).catch(() => {});
    reverseGeocode(destination).then((l) => !cancelled && setDestinationLabel(l)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [origin, destination]);

  // La carte de Home dessine ce que ce panneau lui rapporte.
  useEffect(() => {
    onMapState({ stage, route: route ? { points: route.points } : null });
  }, [stage, route, onMapState]);

  const shareRoute = useCallback(
    (shared: SharedRoute) => {
      // Jamais mis en file par le client temps réel (un tracé périmé serait faux) : hors
      // connexion, le dernier tracé est réémis à la reconnexion (effet ci-dessous).
      if (realtimeClient.getState() !== 'connected') return;
      realtimeClient.send('route.share', {
        rideId,
        phase: shared.phase,
        points: shared.points,
        distanceMeters: shared.distanceMeters,
        durationSeconds: shared.durationSeconds,
      });
    },
    [rideId]
  );

  useEffect(
    () =>
      onRealtimeConnectionStateChange((state) => {
        if (state === 'connected' && routeRef.current) shareRoute(routeRef.current);
      }),
    [shareRoute]
  );

  // Itinéraire de la phase courante : vers le client pendant l'approche (depuis la position du
  // chauffeur, donc dès qu'elle est connue), vers la destination au trajet (depuis le point de
  // prise en charge, où la course commence). Un seul tracé par phase ; un échec réessaie à la
  // position suivante, après `routeRetryCooldownMs`.
  useEffect(() => {
    if (routePhaseRef.current === phase) return;
    const start = phase === 'approach' ? position : (position ?? origin);
    if (!start) return;
    const lastFailure = lastRouteFailureAtRef.current;
    if (lastFailure !== null && Date.now() - lastFailure < settings.routeRetryCooldownMs) return;

    routePhaseRef.current = phase;
    const target = phase === 'approach' ? origin : destination;
    fetchRoute(start, target).then((result) => {
      if (!mountedRef.current) return;
      if (!result) {
        if (routePhaseRef.current === phase) routePhaseRef.current = null;
        lastRouteFailureAtRef.current = Date.now();
        return;
      }
      // Phase dépassée pendant l'attente (« Commencer » cliqué entre-temps) : ce tracé est périmé.
      if (routePhaseRef.current !== phase) return;
      lastRouteFailureAtRef.current = null;
      const shared: SharedRoute = { phase, ...result };
      routeRef.current = shared;
      setRoute(shared);
      shareRoute(shared);
    });
  }, [phase, position, origin, destination, settings.routeRetryCooldownMs, shareRoute]);

  // Changement de phase : le tracé de l'approche n'a plus rien à faire sur la carte du trajet.
  const previousPhaseRef = useRef(phase);
  useEffect(() => {
    if (previousPhaseRef.current === phase) return;
    previousPhaseRef.current = phase;
    routeRef.current = null;
    setRoute(null);
  }, [phase]);

  useEffect(() => {
    return onRealtimeMessage((message) => {
      if (isRideStartedMessage(message) && message.payload.rideId === rideId) {
        enterTransit();
      } else if (isRideCompletedMessage(message) && message.payload.rideId === rideId) {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        onSettle({ rideId, amount: message.payload.amount });
      } else if (isRideCancelledMessage(message) && message.payload.rideId === rideId) {
        setEndedNotice(
          message.payload.cancelledBy === 'client'
            ? 'Le client a annulé la course.'
            : 'La course a été annulée.'
        );
      } else if (
        isSessionSyncedMessage(message) &&
        message.payload.activeRideId === rideId &&
        message.payload.activeRideState === 'in_progress'
      ) {
        // Filet : app tuée puis relancée pendant la course -- reprendre en phase trajet plutôt
        // que de reproposer « Commencer ». `startedAt` n'a plus d'incidence sur `complete` (J24 :
        // la fin de course ne porte que la décision, le relevé vient du service temps réel).
        enterTransit();
      }
    });
  }, [rideId, onSettle, enterTransit]);

  useEffect(() => {
    if (!endedNotice) return;
    const timer = setTimeout(onEnded, 3000);
    return () => clearTimeout(timer);
  }, [endedNotice, onEnded]);

  const getEmergencyPosition = useCallback(() => getCurrentPosition(), []);

  function handleArrived() {
    if (stage !== 'approach') return;
    if (realtimeClient.getState() !== 'connected') {
      setErrorMessage('Hors connexion — impossible de prévenir le client maintenant. Réessayez.');
      return;
    }
    setErrorMessage(null);
    realtimeClient.send('ride.arrived', { rideId });
    stageRef.current = 'arrived';
    setStage('arrived');
  }

  async function handleStart() {
    if (busy || stage !== 'arrived') return;
    setBusy('starting');
    setErrorMessage(null);
    try {
      await apiClient.request('startRide', { pathParams: { id: rideId }, body: {} });
      enterTransit();
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? translateApiError(error) : 'Impossible de démarrer la course. Réessayez.');
    } finally {
      setBusy(null);
    }
  }

  async function handleFinish() {
    if (busy || finishQueued || stageRef.current !== 'transit') return;
    setBusy('finishing');
    setErrorMessage(null);
    try {
      // La fin de course ne porte que la décision (J24) : corps vide.
      await offlineRunner.attempt('completeRide', {
        pathParams: { id: rideId },
        body: {},
        // Synchrone, avant que la promesse ci-dessus ne se résolve (échec réseau) -- l'attente
        // peut durer jusqu'à la prochaine reconnexion, `busy` seul (transitoire) ne suffit pas
        // à le montrer.
        onQueued: () => {
          setBusy(null);
          setFinishQueued(true);
        },
      });
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onSettle({ rideId, amount });
    } catch (error) {
      // Une erreur réseau ne fait jamais rejeter cette promesse (mise en file à la place,
      // ci-dessus) -- seule reste une erreur métier.
      setErrorMessage(error instanceof ApiError ? translateApiError(error) : 'Impossible de terminer la course. Réessayez.');
      setBusy(null);
      setFinishQueued(false);
    }
  }

  function handleFinishRetryNow() {
    // Ne relance pas `handleFinish()` -- la fin de course initiale reste en attente dans
    // `offlineRunner` avec sa propre clé d'idempotence ; `flush()` retente ce qui est déjà en
    // file, sans en créer une seconde.
    // `flush()` ne rejette jamais (manager.ts -- une reconnexion future réessaiera), le `catch`
    // ici n'est qu'une garde contre un rejet imprévu ; rien de plus à faire depuis un écran.
    offlineRunner.flush().catch(() => {});
  }

  if (endedNotice) {
    return (
      <View style={styles.overlay} pointerEvents="box-none" testID="active-ride-screen">
        <View style={[styles.card, styles.endedBanner]} testID="active-ride-cancelled">
          <Text style={styles.endedText}>{endedNotice}</Text>
        </View>
      </View>
    );
  }

  const nearPickup = isWithinRadius(position, origin, settings.arrivalRadiusMeters);
  const tripSummary = formatTripSummary(route);

  return (
    <View style={styles.overlay} pointerEvents="box-none" testID="active-ride-screen">
      <View style={styles.card}>
        <Text style={styles.phaseTitle} testID="active-ride-phase">
          {stage === 'approach' ? 'En route vers le client' : stage === 'arrived' ? 'Sur place' : 'Course en cours'}
        </Text>
        {tripSummary ? (
          <Text style={styles.summary} testID="active-ride-summary">
            {tripSummary}
          </Text>
        ) : null}
        {/* Une adresse inconnue (géocodage indisponible) ne laisse pas de ligne vide « … » :
            la carte montre déjà les points. */}
        {originLabel ? (
          <Text style={styles.pointText} numberOfLines={1} testID="active-ride-origin">
            Client : {originLabel}
          </Text>
        ) : null}
        {destinationLabel ? (
          <Text style={styles.pointText} numberOfLines={1} testID="active-ride-destination">
            Arrivée : {destinationLabel}
          </Text>
        ) : null}
        {errorMessage ? (
          <Text style={styles.error} testID="active-ride-error">
            {errorMessage}
          </Text>
        ) : null}
      </View>

      {/* Le bouton d'urgence reste toujours atteignable, loin du bouton principal, jamais confondu
          avec lui (spécification L6-13). `getPosition` rappelle le GPS à l'instant. */}
      <View style={styles.emergencyCorner}>
        <EmergencyButton rideId={rideId} getPosition={getEmergencyPosition} />
      </View>

      <View style={styles.sideActions}>
        <CallButton clientPhoneNumber={clientPhoneNumber} />
      </View>

      {/* Les trois décisions de la course se confirment d'un glissement, jamais d'un simple appui :
          rien ne se déclenche en roulant, avec des gants, ni par un double appui qui tomberait
          sur le bouton suivant. */}
      <View style={styles.mainAction}>
        {stage === 'approach' && nearPickup ? (
          <SwipeButton testID="active-ride-arrived" label="Sur place" accessibilityLabel="Je suis sur place" onConfirm={handleArrived} />
        ) : null}

        {stage === 'arrived' ? (
          <SwipeButton
            testID="active-ride-start"
            label={busy === 'starting' ? 'Démarrage…' : 'Commencer la course'}
            disabled={busy !== null}
            onConfirm={handleStart}
          />
        ) : null}

        {stage === 'transit' ? (
          finishQueued ? (
            <View style={styles.finishQueued} testID="active-ride-finish-queued">
              <Text style={styles.finishQueuedText}>
                Fin de course en attente — elle sera confirmée automatiquement au retour du réseau.
              </Text>
              <Pressable testID="active-ride-finish-retry" accessibilityRole="button" onPress={handleFinishRetryNow}>
                <Text style={styles.finishQueuedRetry}>Réessayer maintenant</Text>
              </Pressable>
            </View>
          ) : (
            <SwipeButton
              testID="active-ride-finish"
              label={busy === 'finishing' ? 'Fin de course…' : 'Terminer la course'}
              disabled={busy !== null}
              onConfirm={handleFinish}
            />
          )
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    ...cards.floating,
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    gap: 3,
    padding: 16,
  },
  phaseTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
  },
  summary: {
    color: colors.route,
    fontWeight: '600',
  },
  pointText: {
    color: colors.inkSoft,
  },
  error: {
    color: colors.dangerText,
  },
  emergencyCorner: {
    position: 'absolute',
    left: 16,
    bottom: 104,
  },
  sideActions: {
    position: 'absolute',
    right: 16,
    bottom: 104,
    gap: 8,
    alignItems: 'flex-end',
  },
  mainAction: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 28,
  },
  finishQueued: {
    ...cards.floating,
    gap: 8,
    alignItems: 'center',
    backgroundColor: colors.warningSoft,
    padding: 14,
  },
  finishQueuedText: {
    color: colors.warningText,
    textAlign: 'center',
  },
  finishQueuedRetry: {
    color: colors.warningText,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  endedBanner: {
    backgroundColor: colors.warningSoft,
  },
  endedText: {
    color: colors.warningText,
    fontSize: 16,
    textAlign: 'center',
  },
});
