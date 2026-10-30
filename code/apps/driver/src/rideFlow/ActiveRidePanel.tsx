import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fetchRoute, reverseGeocode, type LatLng, type MapRoute } from '@babana/maps';
import { ApiError, QUICK_MESSAGE_LABELS, quickMessagesFor, translateApiError } from '@babana/api-client';
import { MessageBubble, QuickMessageChips } from '@babana/ui';
import { http, type realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';
import { getCurrentPosition } from '../location';
import { CallButton } from '../components/CallButton';
import { EmergencyButton } from '../components/EmergencyButton';
import { SwipeButton } from '../components/SwipeButton';
import { onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { formatDistance } from '../format';
import { distanceToRouteMeters, isWithinRadius, remainingRouteFraction } from './proximity';
import type { ActiveRideParams } from '../navigation/types';
import { buttonLabels, buttons, cards, colors } from '../theme';

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
  /** Écart (m) au tracé au-delà duquel le chauffeur est considéré hors itinéraire : recalcul. */
  routeDeviationMeters: number;
  /** Âge (ms) au-delà duquel un itinéraire est recalculé même sur le tracé (distance/durée à jour). */
  routeRefreshMs: number;
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
function isChatMessage(m: realtime.ServerToClientMessage): m is realtime.ChatMessageMessage {
  return m.type === 'chat.message';
}

// Les messages rapides que le chauffeur peut envoyer, avec leur libellé (même liste que le client
// lit chez lui -- `@babana/api-client`).
const DRIVER_QUICK_MESSAGES = quickMessagesFor('driver').map((code) => ({ code, label: QUICK_MESSAGE_LABELS[code] }));

function isDriverArrivedMessage(m: realtime.ServerToClientMessage): m is realtime.DriverArrivedMessage {
  return m.type === 'driver.arrived';
}

/** « 2:05 » -- minutes et secondes d'attente, jamais négatif. */
export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function isSessionSyncedMessage(m: realtime.ServerToClientMessage): m is realtime.SessionSyncedMessage {
  return m.type === 'session.synced';
}

/** Distance et durée RESTANTES : celles du tracé, au prorata de ce qui reste à parcourir depuis la
 * position courante (`remainingRouteFraction`). */
function formatTripSummary(route: SharedRoute | null, position: LatLng | null): string | null {
  if (!route || route.distanceMeters === null) return null;
  const fraction = position ? remainingRouteFraction(position, route.points) : 1;
  const distance = route.distanceMeters * fraction;
  const minutes = route.durationSeconds === null ? null : Math.max(1, Math.round((route.durationSeconds * fraction) / 60));
  return minutes === null ? formatDistance(distance) : `${formatDistance(distance)} · ≈ ${minutes} min`;
}

export function ActiveRidePanel({ ride, position, settings, onMapState, onSettle, onEnded }: ActiveRidePanelProps) {
  const { rideId, origin, destination, amount, clientPhoneNumber } = ride;

  const [stage, setStage] = useState<RideStage>('approach');
  const [route, setRoute] = useState<SharedRoute | null>(null);
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'arriving' | 'starting' | 'finishing' | 'cancelling'>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  // Fin de course mise en file (réseau absent, L6-16) : distinct de `busy === 'finishing'`, qui
  // ne dure que le temps d'une tentative -- celui-ci peut durer jusqu'à la prochaine
  // reconnexion.
  const [finishQueued, setFinishQueued] = useState(false);
  // Messages rapides : la rangée de messages ouverte ou non, et le dernier message du client
  // (affiché jusqu'à ce que le chauffeur le ferme -- pas de minuteur à deviner).
  const [messagesOpen, setMessagesOpen] = useState(false);
  // « Sur place » tel qu'Odoo l'a enregistré : l'heure d'arrivée (qui fait foi pour l'attente, des
  // deux côtés) et le délai de grâce avant « client absent » -- jamais une valeur de l'app.
  const [arrival, setArrival] = useState<{ arrivedAtMs: number; graceSeconds: number } | null>(null);
  const [noShowConfirm, setNoShowConfirm] = useState(false);
  const [, forceTick] = useState(0);
  const [incomingMessage, setIncomingMessage] = useState<realtime.QuickMessageCode | null>(null);

  // Lu de façon synchrone par les gestionnaires de messages -- `stage` (état React) y serait
  // périmé (l'effet d'abonnement ne s'exécute qu'une fois, dépendances [rideId]).
  const stageRef = useRef<RideStage>('approach');
  // La fin de course peut arriver par deux chemins presque simultanés -- la réponse HTTP à
  // `completeRide`, et le message `ride.completed` (L3-19, poussé aussi au chauffeur). Un seul
  // doit conclure.
  const resolvedRef = useRef(false);
  // Itinéraire : la phase d'une requête en vol (une seule à la fois par phase), le dernier tracé
  // (réémis à la reconnexion, comparé à la position pour détecter un écart) et son âge, l'instant
  // du dernier échec (délai avant un nouvel essai), et l'état de montage (une réponse tardive ne
  // touche rien après démontage).
  const inFlightPhaseRef = useRef<'approach' | 'transit' | null>(null);
  const routeRef = useRef<SharedRoute | null>(null);
  const routeFetchedAtRef = useRef<number | null>(null);
  const lastRouteFailureAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const phase: 'approach' | 'transit' = stage === 'transit' ? 'transit' : 'approach';

  // `arrivedAtMs` est une heure de CE téléphone : jamais l'heure du serveur comparée à l'horloge
  // locale (deux horloges qui dérivent -- l'attente afficherait 0:00 ou un délai déjà écoulé).
  const enterArrived = useCallback((localArrivedAtMs: number, graceSeconds: number) => {
    setArrival((current) => current ?? { arrivedAtMs: localArrivedAtMs, graceSeconds });
    if (stageRef.current !== 'approach') return;
    stageRef.current = 'arrived';
    setStage('arrived');
  }, []);

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
  // chauffeur, donc dès qu'elle est connue), vers la destination au trajet (depuis la position, ou
  // à défaut le point de prise en charge). Recalculé quand le chauffeur s'écarte du tracé
  // (`routeDeviationMeters`) ou que le tracé vieillit (`routeRefreshMs`) -- jamais en attente sur
  // place. Un échec réessaie à la position suivante, après `routeRetryCooldownMs`.
  useEffect(() => {
    if (stage === 'arrived') return;
    if (inFlightPhaseRef.current === phase) return;
    const lastFailure = lastRouteFailureAtRef.current;
    if (lastFailure !== null && Date.now() - lastFailure < settings.routeRetryCooldownMs) return;

    const current = routeRef.current && routeRef.current.phase === phase ? routeRef.current : null;
    if (current) {
      if (!position) return;
      const offRoute = distanceToRouteMeters(position, current.points) > settings.routeDeviationMeters;
      const stale = routeFetchedAtRef.current !== null && Date.now() - routeFetchedAtRef.current >= settings.routeRefreshMs;
      if (!offRoute && !stale) return;
    }
    const start = phase === 'approach' ? position : (position ?? origin);
    if (!start) return;

    inFlightPhaseRef.current = phase;
    const target = phase === 'approach' ? origin : destination;
    fetchRoute(start, target).then((result) => {
      if (inFlightPhaseRef.current === phase) inFlightPhaseRef.current = null;
      if (!mountedRef.current) return;
      if (!result) {
        lastRouteFailureAtRef.current = Date.now();
        return;
      }
      // Phase dépassée pendant l'attente (« Commencer » glissé entre-temps) : ce tracé est périmé.
      const nowPhase = stageRef.current === 'transit' ? 'transit' : 'approach';
      if (nowPhase !== phase) return;
      lastRouteFailureAtRef.current = null;
      const shared: SharedRoute = { phase, ...result };
      routeRef.current = shared;
      routeFetchedAtRef.current = Date.now();
      setRoute(shared);
      shareRoute(shared);
    });
  }, [
    stage,
    phase,
    position,
    origin,
    destination,
    settings.routeRetryCooldownMs,
    settings.routeDeviationMeters,
    settings.routeRefreshMs,
    shareRoute,
  ]);

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
      if (isDriverArrivedMessage(message) && message.payload.rideId === rideId) {
        // « Sur place » déclaré depuis un autre appareil du chauffeur, ou rejoué après reconnexion.
        // Âge de l'arrivée mesuré entre deux heures du serveur (émission du message, arrivée),
        // puis reporté sur l'horloge locale.
        const ageMs = Math.max(0, Date.parse(message.emittedAt) - Date.parse(message.payload.arrivedAt));
        enterArrived(Date.now() - (Number.isNaN(ageMs) ? 0 : ageMs), message.payload.noShowGraceSeconds);
      } else if (isChatMessage(message) && message.payload.rideId === rideId) {
        if (message.payload.from === 'client') setIncomingMessage(message.payload.code);
      } else if (isRideStartedMessage(message) && message.payload.rideId === rideId) {
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
  }, [rideId, onSettle, enterTransit, enterArrived]);

  useEffect(() => {
    if (!endedNotice) return;
    const timer = setTimeout(onEnded, 3000);
    return () => clearTimeout(timer);
  }, [endedNotice, onEnded]);

  // Le compteur d'attente avance chaque seconde, seulement pendant l'attente.
  useEffect(() => {
    if (stage !== 'arrived') return undefined;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const getEmergencyPosition = useCallback(() => getCurrentPosition(), []);

  function handleSendQuickMessage(code: realtime.QuickMessageCode) {
    setMessagesOpen(false);
    // Jamais mis en file (un « J'arrive » lu dix minutes plus tard serait faux) : hors connexion,
    // on le dit tout de suite.
    if (realtimeClient.getState() !== 'connected') {
      setErrorMessage('Hors connexion — message non envoyé. Réessayez ou appelez le client.');
      return;
    }
    setErrorMessage(null);
    realtimeClient.send('chat.send', { rideId, code });
  }

  async function handleArrived() {
    if (stage !== 'approach' || busy) return;
    setBusy('arriving');
    setErrorMessage(null);
    try {
      // Une décision, une écriture (invariant 1) : Odoo enregistre l'heure d'arrivée et prévient le
      // client au commit. Jamais mis en file : un « Sur place » rejoué plus tard mentirait sur
      // l'heure, qui fait foi pour l'attente.
      const response = (await apiClient.request('driverArrived', {
        pathParams: { id: rideId },
        body: {},
      })) as http.DriverArrivedResponse;
      // Odoo vient de l'écrire : l'attente commence maintenant, à l'heure de ce téléphone.
      enterArrived(Date.now(), response.noShowGraceSeconds);
    } catch (error) {
      setErrorMessage(
        error instanceof ApiError
          ? translateApiError(error)
          : 'Hors connexion — « Sur place » non enregistré. Réessayez dès que le réseau revient.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleNoShow() {
    if (busy) return;
    setBusy('cancelling');
    setErrorMessage(null);
    try {
      // Le serveur seul juge du délai (NO_SHOW_TOO_EARLY sinon) -- l'app n'a fait qu'afficher le
      // bouton au bon moment.
      await apiClient.request('cancelRide', { pathParams: { id: rideId }, body: { reason: http.NO_SHOW_CANCEL_REASON } });
      onEnded();
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? translateApiError(error) : 'Hors connexion — réessayez dès que le réseau revient.');
      setNoShowConfirm(false);
    } finally {
      setBusy(null);
    }
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
        <View style={[styles.card, styles.endedFloating, styles.endedBanner]} testID="active-ride-cancelled">
          <Text style={styles.endedText}>{endedNotice}</Text>
        </View>
      </View>
    );
  }

  const nearPickup = isWithinRadius(position, origin, settings.arrivalRadiusMeters);
  const tripSummary = formatTripSummary(route, position);

  return (
    <View style={styles.overlay} pointerEvents="box-none" testID="active-ride-screen">
      <View style={styles.topStack} pointerEvents="box-none">
      <View style={styles.card}>
        <Text style={styles.phaseTitle} testID="active-ride-phase">
          {stage === 'approach' ? 'En route vers le client' : stage === 'arrived' ? 'Sur place' : 'Course en cours'}
        </Text>
        {tripSummary && stage !== 'arrived' ? (
          <Text style={styles.summary} testID="active-ride-summary">
            {tripSummary}
          </Text>
        ) : null}
        {stage === 'arrived' && arrival ? (
          <Text style={styles.waiting} testID="active-ride-waiting">
            En attente du client · {formatWait((Date.now() - arrival.arrivedAtMs) / 1000)}
          </Text>
        ) : null}
        {/* « Client absent » : seulement une fois le délai de grâce écoulé (le serveur tranche). */}
        {stage === 'arrived' && arrival && Date.now() - arrival.arrivedAtMs >= arrival.graceSeconds * 1000 ? (
          <View style={styles.noShowRow}>
            {noShowConfirm ? (
              <>
                <Pressable
                  testID="active-ride-no-show-cancel"
                  accessibilityRole="button"
                  onPress={() => setNoShowConfirm(false)}
                  style={({ pressed }) => [buttons.base, buttons.md, buttons.secondary, buttons.floating, pressed ? buttons.pressed : null]}
                >
                  <Text style={[buttonLabels.base, buttonLabels.secondary]}>Attendre encore</Text>
                </Pressable>
                <Pressable
                  testID="active-ride-no-show-confirm"
                  accessibilityRole="button"
                  accessibilityLabel="Confirmer : le client est absent, annuler la course"
                  disabled={busy !== null}
                  onPress={handleNoShow}
                  style={({ pressed }) => [buttons.base, buttons.md, buttons.dangerSoft, buttons.floating, pressed ? buttons.pressed : null]}
                >
                  <Text style={[buttonLabels.base, buttonLabels.danger]}>{busy === 'cancelling' ? 'Annulation…' : 'Confirmer : client absent'}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                testID="active-ride-no-show"
                accessibilityRole="button"
                onPress={() => setNoShowConfirm(true)}
                style={({ pressed }) => [buttons.base, buttons.md, buttons.secondary, buttons.floating, pressed ? buttons.pressed : null]}
              >
                <Text style={[buttonLabels.base, buttonLabels.danger]}>Client absent</Text>
              </Pressable>
            )}
          </View>
        ) : null}
        {/* Le repère du client sert à le trouver : montré jusqu'au départ, pas pendant le trajet. */}
        {ride.pickupNote && stage !== 'transit' ? (
          <Text style={styles.pickupNote} numberOfLines={2} testID="active-ride-pickup-note">
            Repère : « {ride.pickupNote} »
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
      {incomingMessage ? (
        <MessageBubble
          testID="active-ride-incoming-message"
          author="Client"
          text={QUICK_MESSAGE_LABELS[incomingMessage]}
          onDismiss={() => setIncomingMessage(null)}
        />
      ) : null}
      </View>

      {/* Le bouton d'urgence reste toujours atteignable, loin du bouton principal, jamais confondu
          avec lui (spécification L6-13). `getPosition` rappelle le GPS à l'instant. */}
      <View style={styles.emergencyCorner}>
        <EmergencyButton rideId={rideId} getPosition={getEmergencyPosition} />
      </View>

      <View style={styles.sideActions}>
        {stage !== 'transit' ? (
          <Pressable
            testID="active-ride-messages-toggle"
            accessibilityRole="button"
            accessibilityLabel="Envoyer un message rapide au client"
            accessibilityState={{ expanded: messagesOpen }}
            onPress={() => setMessagesOpen((open) => !open)}
            style={({ pressed }) => [buttons.base, buttons.md, buttons.secondary, buttons.floating, pressed ? buttons.pressed : null]}
          >
            <Text style={[buttonLabels.base, buttonLabels.secondary]}>Message</Text>
          </Pressable>
        ) : null}
        <CallButton clientPhoneNumber={clientPhoneNumber} />
      </View>

      {messagesOpen && stage !== 'transit' ? (
        <View style={styles.messagesTray}>
          <QuickMessageChips options={DRIVER_QUICK_MESSAGES} onSend={handleSendQuickMessage} testID="active-ride-quick-messages" />
        </View>
      ) : null}

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
  topStack: {
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    gap: 8,
  },
  card: {
    ...cards.floating,
    gap: 3,
    padding: 16,
  },
  messagesTray: {
    ...cards.floating,
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 220,
    padding: 10,
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
  pickupNote: {
    color: colors.ink,
    fontWeight: '600',
  },
  waiting: {
    color: colors.warningText,
    fontWeight: '700',
  },
  noShowRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
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
  endedFloating: {
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
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
