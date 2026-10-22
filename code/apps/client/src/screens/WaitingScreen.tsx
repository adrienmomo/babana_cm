import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { asDriverId } from '@babana/navigation';
import { ApiError, USER_MESSAGES, reportMetric, translateApiError } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatMoney } from '../format';
import { ensureRealtimeConnected, onRealtimeMessage, realtimeClient } from '../realtime';
import type { ClientParamList } from '../navigation/types';

/**
 * Attente d'un chauffeur. La course part au chauffeur disponible le plus proche, choisi par le
 * serveur (D10 retiré) ; s'il refuse ou ne répond pas, le serveur sollicite de lui-même le suivant
 * (D11 retiré). Cet écran lance la recherche, dit où elle en est, et ne décide jamais rien : chaque
 * issue lui vient du serveur -- `ride.assigned` (un chauffeur a accepté), `ride.rejected` (un
 * chauffeur a décliné, le suivant est sollicité), `ride.unmatched` (plus personne : « Réessayer » ou
 * « Annuler »).
 */

type Props = NativeStackScreenProps<ClientParamList, 'Waiting'>;

type Phase =
  | { kind: 'searching' }
  | { kind: 'proposed' }
  | { kind: 'moving-on'; reason: realtime.RideRejectedMessage['payload']['reason'] }
  | { kind: 'unmatched' }
  | { kind: 'failed'; message: string };

const MOVING_ON_MESSAGES: Record<realtime.RideRejectedMessage['payload']['reason'], string> = {
  driver_rejected: "Ce chauffeur n'est pas disponible.",
  driver_timeout: "Ce chauffeur n'a pas répondu.",
};

function isRideAssigned(message: realtime.ServerToClientMessage): message is realtime.RideAssignedMessage {
  return message.type === 'ride.assigned';
}

function isRideRejected(message: realtime.ServerToClientMessage): message is realtime.RideRejectedMessage {
  return message.type === 'ride.rejected';
}

function isRideUnmatched(message: realtime.ServerToClientMessage): message is realtime.RideUnmatchedMessage {
  return message.type === 'ride.unmatched';
}

function isSessionSynced(message: realtime.ServerToClientMessage): message is realtime.SessionSyncedMessage {
  return message.type === 'session.synced';
}

export function WaitingScreen({ route, navigation }: Props) {
  const { rideId, amount, origin, destination, requestedAt } = route.params;
  const [phase, setPhase] = useState<Phase>({ kind: 'searching' });
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Refus essuyés sur cette course -- instrumentés à l'abandon (L6-08, critère 5).
  const rejections = useRef(0);
  // Une recherche lancée par montage, pas deux (montage double en développement).
  const started = useRef(false);

  const dispatch = useCallback(async () => {
    setPhase({ kind: 'searching' });
    try {
      await apiClient.request('dispatchRide', { pathParams: { id: rideId }, body: {} });
      setPhase({ kind: 'proposed' });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'NO_DRIVER_AVAILABLE') {
        setPhase({ kind: 'unmatched' });
      } else if (cause instanceof ApiError && cause.code === 'RIDE_INVALID_TRANSITION') {
        // La course n'est plus à commander : une recherche est déjà en cours (écran rouvert,
        // requête rejouée) -- son issue arrivera par le temps réel, comme les autres.
        setPhase({ kind: 'proposed' });
      } else if (cause instanceof ApiError) {
        setPhase({ kind: 'failed', message: translateApiError(cause) });
      } else if (realtimeClient.getState() !== 'connected') {
        setPhase({ kind: 'failed', message: 'Hors connexion : la recherche nécessite une connexion. Réessayez une fois reconnecté.' });
      } else {
        setPhase({ kind: 'failed', message: 'La recherche a échoué. Réessayez.' });
      }
    }
  }, [rideId]);

  useEffect(() => {
    ensureRealtimeConnected();
    if (!started.current) {
      started.current = true;
      dispatch();
    }
  }, [dispatch]);

  useEffect(
    () =>
      onRealtimeMessage((message) => {
        if (isRideAssigned(message) && message.payload.rideId === rideId) {
          navigation.replace('Tracking', {
            rideId,
            origin,
            destination,
            driver: {
              driverId: asDriverId(message.payload.driverId),
              firstName: message.payload.firstName,
              photoUrl: message.payload.photoUrl,
              motorcycleClass: message.payload.motorcycleClass,
              licensePlate: message.payload.licensePlate,
              phoneNumber: message.payload.phoneNumber,
            },
          });
        } else if (isRideRejected(message) && message.payload.rideId === rideId) {
          rejections.current += 1;
          setPhase({ kind: 'moving-on', reason: message.payload.reason });
        } else if (isRideUnmatched(message) && message.payload.rideId === rideId) {
          setPhase({ kind: 'unmatched' });
        } else if (
          isSessionSynced(message) &&
          message.payload.rideStateKnown &&
          message.payload.activeRideId === rideId &&
          message.payload.activeRideState === 'rejected'
        ) {
          // Reconnexion : `ride.unmatched` a pu partir pendant la coupure. Une course restée
          // « rejected » côté Odoo est une course pour laquelle plus personne n'est sollicité.
          setPhase({ kind: 'unmatched' });
        }
      }),
    [rideId, navigation, origin, destination]
  );

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiClient.request('cancelRide', { pathParams: { id: rideId }, body: {} });
      // Critère 5 (L6-08) : instrumenter chaque abandon avec son rang (nombre de refus déjà
      // essuyés sur cette course) et son délai depuis la commande -- la donnée que L9-09 mesure.
      reportMetric('client.ride_abandoned', {
        rejectionStreak: rejections.current,
        elapsedMs: Date.now() - requestedAt,
      });
      navigation.navigate('Home');
    } catch (cause) {
      setCancelError(cause instanceof ApiError ? translateApiError(cause) : "L'annulation a échoué. Réessayez.");
      setCancelling(false);
    }
  }

  const searching = phase.kind === 'searching' || phase.kind === 'proposed' || phase.kind === 'moving-on';

  return (
    <View style={styles.container}>
      {searching ? <ActivityIndicator size="large" testID="waiting-spinner" /> : null}
      <Text style={styles.title} testID="waiting-status">
        {phase.kind === 'searching'
          ? 'Recherche du chauffeur le plus proche…'
          : phase.kind === 'proposed'
            ? 'Un chauffeur proche a reçu votre demande…'
            : phase.kind === 'moving-on'
              ? `${MOVING_ON_MESSAGES[phase.reason]} Recherche d'un autre chauffeur…`
              : phase.kind === 'unmatched'
                ? USER_MESSAGES.NO_DRIVER_AVAILABLE
                : phase.message}
      </Text>
      <Text style={styles.amount}>{formatMoney(amount)}</Text>
      {phase.kind === 'unmatched' || phase.kind === 'failed' ? (
        <Button testID="retry-dispatch" label="Réessayer" onPress={dispatch} />
      ) : null}
      {cancelError ? <Text style={styles.error}>{cancelError}</Text> : null}
      <Button testID="cancel-waiting" label="Annuler" variant="secondary" onPress={handleCancel} disabled={cancelling} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  amount: {
    fontSize: 28,
    fontWeight: '700',
  },
  error: {
    color: '#B91C1C',
    textAlign: 'center',
  },
});
