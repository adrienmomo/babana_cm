import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { reverseGeocode } from '@babana/maps';
import { ApiError, translateApiError } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';
import { getCurrentPosition } from '../location';
import { CallButton } from '../components/CallButton';
import { EmergencyButton } from '../components/EmergencyButton';
import { launchRideNavigation, type RidePhase } from '../navigation/launch';
import { onRealtimeMessage } from '../realtime';
import { replaceWithSettlement } from '../navigation/transitions';
import type { DriverParamList } from '../navigation/types';

/**
 * Course en cours, côté chauffeur (L6-13, D12).
 *
 * Deux phases : approche vers le client, puis trajet vers la destination. Le passage de l'une à
 * l'autre est **une décision humaine** ("Démarrer la course"), jamais déduit d'une position --
 * invariant 1 : le nombre d'écritures d'une course est borné par le nombre de décisions qu'elle a
 * comportées. Idem pour la fin ("Terminer la course").
 *
 * Le guidage passe par `@babana/maps` (lien profond Google Maps, D12) : l'app reste vivante
 * derrière, l'état de course est préservé, le retour retrouve cet écran (React Navigation ne le
 * démonte pas). `session.synced` sert de filet si l'app a été tuée puis relancée en pleine course.
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

type Props = NativeStackScreenProps<DriverParamList, 'ActiveRide'>;

const HOLD_TO_FINISH_MS = 900;

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

export function ActiveRideScreen({ route, navigation }: Props) {
  const { rideId, origin, destination, amount, clientPhoneNumber } = route.params;

  const [phase, setPhase] = useState<RidePhase>('approach');
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'starting' | 'finishing'>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  // Fin de course mise en file (réseau absent, L6-16) : distinct de `busy === 'finishing'`, qui
  // ne dure que le temps d'une tentative -- celui-ci peut durer jusqu'à la prochaine
  // reconnexion.
  const [finishQueued, setFinishQueued] = useState(false);

  // Lu de façon synchrone par les gestionnaires de messages -- `phase` (état React) y serait
  // périmé (l'effet d'abonnement ne s'exécute qu'une fois, dépendances [rideId]).
  const phaseRef = useRef<RidePhase>('approach');
  // La fin de course peut arriver par deux chemins presque simultanés -- la réponse HTTP à
  // `completeRide`, et le message `ride.completed` (L3-19, poussé aussi au chauffeur). Un seul
  // doit naviguer.
  const resolvedRef = useRef(false);

  const enterTransit = useCallback(() => {
    phaseRef.current = 'transit';
    setPhase('transit');
  }, []);

  useEffect(() => {
    let cancelled = false;
    reverseGeocode(origin).then((l) => !cancelled && setOriginLabel(l)).catch(() => {});
    reverseGeocode(destination).then((l) => !cancelled && setDestinationLabel(l)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [origin, destination]);

  useEffect(() => {
    return onRealtimeMessage((message) => {
      if (isRideStartedMessage(message) && message.payload.rideId === rideId) {
        if (phaseRef.current === 'approach') enterTransit();
      } else if (isRideCompletedMessage(message) && message.payload.rideId === rideId) {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        replaceWithSettlement(navigation, { rideId, amount: message.payload.amount });
      } else if (isRideCancelledMessage(message) && message.payload.rideId === rideId) {
        setEndedNotice(
          message.payload.cancelledBy === 'client'
            ? 'Le client a annulé la course.'
            : 'La course a été annulée.'
        );
      } else if (
        isSessionSyncedMessage(message) &&
        message.payload.activeRideId === rideId &&
        message.payload.activeRideState === 'in_progress' &&
        phaseRef.current === 'approach'
      ) {
        // Filet : app tuée puis relancée pendant la course -- reprendre en phase trajet plutôt
        // que de reproposer « Démarrer ». `startedAt` n'a plus d'incidence sur `complete` (J24 :
        // la fin de course ne porte que la décision, le relevé vient du service temps réel).
        enterTransit();
      }
    });
  }, [rideId, amount, navigation, enterTransit]);

  useEffect(() => {
    if (!endedNotice) return;
    const timer = setTimeout(() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] }), 3000);
    return () => clearTimeout(timer);
  }, [endedNotice, navigation]);

  const getEmergencyPosition = useCallback(() => getCurrentPosition(), []);

  function openGuidance() {
    launchRideNavigation(phase, { origin, destination });
  }

  async function handleStart() {
    if (busy) return;
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
    if (busy || finishQueued || phaseRef.current !== 'transit') return;
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
      replaceWithSettlement(navigation, { rideId, amount });
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
      <View style={styles.container} testID="active-ride-screen">
        <View style={styles.endedBanner} testID="active-ride-cancelled">
          <Text style={styles.endedText}>{endedNotice}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="active-ride-screen">
      <Text style={styles.phaseTitle} testID="active-ride-phase">
        {phase === 'approach' ? 'En route vers le client' : 'Course en cours'}
      </Text>

      <View style={styles.points}>
        <Text style={styles.pointText} numberOfLines={1} testID="active-ride-origin">
          Client : {originLabel ?? '…'}
        </Text>
        <Text style={styles.pointText} numberOfLines={1} testID="active-ride-destination">
          Arrivée : {destinationLabel ?? '…'}
        </Text>
      </View>

      <CallButton clientPhoneNumber={clientPhoneNumber} />

      <Pressable
        testID="active-ride-navigate"
        accessibilityRole="button"
        accessibilityLabel="Ouvrir l'itinéraire dans Google Maps"
        onPress={openGuidance}
        style={({ pressed }) => [styles.navButton, pressed ? styles.pressed : null]}
      >
        <Text style={styles.navLabel}>
          {phase === 'approach' ? 'Guidage vers le client' : 'Guidage vers l’arrivée'}
        </Text>
      </Pressable>

      {errorMessage ? (
        <Text style={styles.error} testID="active-ride-error">
          {errorMessage}
        </Text>
      ) : null}

      <View style={styles.spacer} />

      {/* Le bouton d'urgence : au milieu, toujours atteignable, jamais confondu avec le bouton de
          fin (spécification L6-13). `getPosition` rappelle le GPS à l'instant -- voir src/location.ts. */}
      <EmergencyButton rideId={rideId} getPosition={getEmergencyPosition} />

      <View style={styles.spacer} />

      {phase === 'approach' ? (
        <Pressable
          testID="active-ride-start"
          accessibilityRole="button"
          accessibilityLabel="Démarrer la course"
          disabled={busy !== null}
          onPress={handleStart}
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.primaryLabel}>{busy === 'starting' ? 'Démarrage…' : 'Démarrer la course'}</Text>
        </Pressable>
      ) : (
        // Fin de course : maintien prolongé (pas un dialogue à lire), et placé tout en bas, loin
        // du bouton de guidage qu'on touche en roulant -- une fin déclenchée par erreur est
        // pénible à rattraper (spécification L6-13, critère 4).
        <View style={styles.finishZone}>
          {finishQueued ? (
            <View style={styles.finishQueued} testID="active-ride-finish-queued">
              <Text style={styles.finishQueuedText}>
                Fin de course en attente — elle sera confirmée automatiquement au retour du réseau.
              </Text>
              <Pressable
                testID="active-ride-finish-retry"
                accessibilityRole="button"
                onPress={handleFinishRetryNow}
              >
                <Text style={styles.finishQueuedRetry}>Réessayer maintenant</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={styles.finishHint}>Maintenez pour terminer</Text>
              <Pressable
                testID="active-ride-finish"
                accessibilityRole="button"
                accessibilityLabel="Maintenir pour terminer la course"
                disabled={busy !== null}
                delayLongPress={HOLD_TO_FINISH_MS}
                onLongPress={handleFinish}
                style={({ pressed }) => [styles.finishButton, pressed ? styles.finishButtonHeld : null]}
              >
                <Text style={styles.finishLabel}>{busy === 'finishing' ? 'Fin de course…' : 'Terminer la course'}</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 12,
    backgroundColor: '#FFFFFF',
  },
  phaseTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  points: {
    gap: 4,
  },
  pointText: {
    color: '#374151',
  },
  navButton: {
    minHeight: 64,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1D4ED8',
    paddingHorizontal: 16,
  },
  navLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  error: {
    color: '#DC2626',
  },
  spacer: {
    flex: 1,
  },
  primaryButton: {
    minHeight: 72,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A7D3D',
  },
  primaryLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  finishZone: {
    gap: 6,
    alignItems: 'center',
  },
  finishHint: {
    color: '#6B7280',
    fontSize: 13,
  },
  finishButton: {
    minHeight: 72,
    alignSelf: 'stretch',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#DC2626',
    backgroundColor: '#FFFFFF',
  },
  finishButtonHeld: {
    backgroundColor: '#FEE2E2',
  },
  finishLabel: {
    color: '#DC2626',
    fontSize: 18,
    fontWeight: '700',
  },
  finishQueued: {
    gap: 8,
    alignItems: 'center',
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 14,
    alignSelf: 'stretch',
  },
  finishQueuedText: {
    color: '#92400E',
    textAlign: 'center',
  },
  finishQueuedRetry: {
    color: '#92400E',
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.85,
  },
  endedBanner: {
    marginTop: 40,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 16,
  },
  endedText: {
    color: '#92400E',
    fontSize: 16,
    textAlign: 'center',
  },
});
