import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { asDriverId } from '@babana/navigation';
import { ApiError, reportMetric, translateApiError } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatMoney } from '../format';
import { ensureRealtimeConnected, onRealtimeMessage } from '../realtime';
import type { ClientParamList } from '../navigation/types';

/**
 * Attente de la réponse du chauffeur choisi (L6-07 -> L6-08). Compte à rebours **indicatif** --
 * le serveur seul est juge de l'expiration (spécification L3-07) : cet écran ne fait qu'afficher
 * ce que `ride.assigned` / `ride.rejected` lui apprennent, il ne décide jamais lui-même qu'une
 * proposition a expiré.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Waiting'>;

function isRideAssigned(message: realtime.ServerToClientMessage): message is realtime.RideAssignedMessage {
  return message.type === 'ride.assigned';
}

function isRideRejected(message: realtime.ServerToClientMessage): message is realtime.RideRejectedMessage {
  return message.type === 'ride.rejected';
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function WaitingScreen({ route, navigation }: Props) {
  const { rideId, proposalExpiresAt, amount, selectedAt, selection } = route.params;
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // Les trois issues possibles (acceptation, refus, expiration) arrivent toutes par ce canal --
  // aucune n'est décidée localement.
  useEffect(() => {
    ensureRealtimeConnected();
    return onRealtimeMessage((message) => {
      if (isRideAssigned(message) && message.payload.rideId === rideId) {
        navigation.replace('Tracking', {
          rideId,
          origin: selection.origin,
          destination: selection.destination,
          driver: {
            driverId: asDriverId(message.payload.driverId),
            firstName: message.payload.firstName,
            photoUrl: message.payload.photoUrl,
            motorcycleClass: message.payload.motorcycleClass,
            licensePlate: message.payload.licensePlate,
          },
        });
      } else if (isRideRejected(message) && message.payload.rideId === rideId) {
        navigation.replace('DriverRejected', {
          rideId,
          driverId: asDriverId(message.payload.driverId),
          reason: message.payload.reason,
          selection,
        });
      }
    });
  }, [rideId, navigation, selection]);

  // Un tick par seconde pour rafraîchir le compte à rebours affiché -- purement indicatif.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiClient.request('cancelRide', { pathParams: { id: rideId }, body: {} });
      // Critère 5 (L6-08) : instrumenter chaque abandon avec son rang (nombre de refus déjà
      // essuyés sur cette course) et son délai (temps écoulé depuis la sélection qui vient
      // d'être annulée) -- c'est la donnée que L9-09 mesurera.
      reportMetric('client.ride_abandoned', {
        rejectionStreak: selection.rejectionStreak,
        elapsedMs: Date.now() - selectedAt,
      });
      navigation.navigate('Home');
    } catch (cause) {
      setCancelError(cause instanceof ApiError ? translateApiError(cause) : "L'annulation a échoué. Réessayez.");
      setCancelling(false);
    }
  }

  const remaining = remainingSeconds(proposalExpiresAt);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>En attente du chauffeur…</Text>
      <Text style={styles.amount}>{formatMoney(amount)}</Text>
      <Text style={styles.countdown} testID="waiting-countdown">
        {remaining > 0 ? `Réponse attendue sous ${remaining} s` : 'La réponse ne devrait plus tarder…'}
      </Text>
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
  },
  amount: {
    fontSize: 28,
    fontWeight: '700',
  },
  countdown: {
    color: '#6B7280',
  },
  error: {
    color: '#B91C1C',
    textAlign: 'center',
  },
});
