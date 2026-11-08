import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { MAP_MARKER_COLORS, MapView, type MapMarker } from '@babana/maps';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, CancelRideSheet } from '@babana/ui';
import { asDriverId } from '@babana/navigation';
import { ApiError, USER_MESSAGES, reportMetric, translateApiError } from '@babana/api-client';
import type { http, realtime } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatMoney } from '../format';
import { ensureRealtimeConnected, onRealtimeMessage, realtimeClient } from '../realtime';
import type { ClientParamList } from '../navigation/types';
import { CLIENT_CANCEL_REASONS } from '../cancelReasons';

/**
 * Attente d'un chauffeur. La course part au chauffeur disponible le plus proche, choisi par le
 * serveur (D10 retiré) ; s'il refuse ou ne répond pas, le serveur sollicite de lui-même le suivant
 * (D11 retiré). Cet écran lance la recherche, dit où elle en est, et ne décide jamais rien : chaque
 * issue lui vient du serveur -- `ride.assigned` (un chauffeur a accepté), `ride.rejected` (un
 * chauffeur a décliné, le suivant est sollicité), `ride.unmatched` (plus personne : « Réessayer » ou
 * « Annuler »).
 *
 * Personne dans le premier cercle : le serveur répond `searching` (202) et élargit lui-même la
 * recherche après un délai (31 octobre) -- l'écran le dit et attend, l'issue arrive par les mêmes
 * messages.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Waiting'>;

type Phase =
  | { kind: 'searching' }
  | { kind: 'widening' }
  | { kind: 'proposed' }
  | { kind: 'moving-on'; reason: realtime.RideRejectedMessage['payload']['reason'] }
  | { kind: 'unmatched' }
  | { kind: 'failed'; message: string };

const MOVING_ON_MESSAGES: Record<realtime.RideRejectedMessage['payload']['reason'], string> = {
  driver_rejected: "Ce chauffeur n'est pas disponible.",
  driver_timeout: "Ce chauffeur n'a pas répondu.",
};

function statusText(phase: Phase): string {
  switch (phase.kind) {
    case 'searching':
      return 'Recherche du chauffeur le plus proche…';
    case 'widening':
      return 'Personne tout près : la recherche s’élargit…';
    case 'proposed':
      return 'Un chauffeur proche a reçu votre demande…';
    case 'moving-on':
      return `${MOVING_ON_MESSAGES[phase.reason]} Recherche d'un autre chauffeur…`;
    case 'unmatched':
      return USER_MESSAGES.NO_DRIVER_AVAILABLE;
    case 'failed':
      return phase.message;
  }
}

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
  // 6 novembre : « Annuler » demande d'abord pourquoi (facultatif pour le client).
  const [cancelSheetOpen, setCancelSheetOpen] = useState(false);
  // Refus essuyés sur cette course -- instrumentés à l'abandon (L6-08, critère 5).
  const rejections = useRef(0);
  // Une recherche lancée par montage, pas deux (montage double en développement).
  const started = useRef(false);

  const dispatch = useCallback(async () => {
    setPhase({ kind: 'searching' });
    try {
      const response = (await apiClient.request('dispatchRide', { pathParams: { id: rideId }, body: {} })) as http.DispatchRideResponse;
      setPhase(response.searching ? { kind: 'widening' } : { kind: 'proposed' });
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

  async function handleCancel(reason: string | null) {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiClient.request('cancelRide', { pathParams: { id: rideId }, body: reason ? { reason } : {} });
      // Critère 5 (L6-08) : instrumenter chaque abandon avec son rang (nombre de refus déjà
      // essuyés sur cette course) et son délai depuis la commande -- la donnée que L9-09 mesure.
      reportMetric('client.ride_abandoned', {
        rejectionStreak: rejections.current,
        elapsedMs: Date.now() - requestedAt,
      });
      setCancelSheetOpen(false);
      // Remise à zéro : l'attente est seule dans la pile (transitions.ts) -- navigate empilerait
      // l'accueil par-dessus, et un retour ramènerait à l'attente d'une course annulée.
      navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
    } catch (cause) {
      setCancelError(cause instanceof ApiError ? translateApiError(cause) : "L'annulation a échoué. Réessayez.");
      setCancelling(false);
      setCancelSheetOpen(false);
    }
  }

  const searching =
    phase.kind === 'searching' || phase.kind === 'widening' || phase.kind === 'proposed' || phase.kind === 'moving-on';

  const markers: MapMarker[] = [
    { id: 'pickup', kind: 'pickup', position: origin.position, label: 'Départ' },
    { id: 'dropoff', kind: 'dropoff', position: destination.position, label: 'Arrivée' },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapView center={origin.position} markers={markers} style={styles.map} />
        {/* La recherche se voit : un halo qui pulse autour du point de départ, au centre de la carte. */}
        {searching ? <SearchPulse /> : null}
      </View>
      <View style={styles.card}>
      {searching ? <ActivityIndicator size="small" testID="waiting-spinner" /> : null}
      <Text style={styles.title} testID="waiting-status">
        {statusText(phase)}
      </Text>
      <Text style={styles.route} numberOfLines={1}>
        {origin.label} → {destination.label}
      </Text>
      <Text style={styles.amount}>{formatMoney(amount)}</Text>
      <Text style={styles.payment}>Paiement en espèces au chauffeur</Text>
      {phase.kind === 'unmatched' || phase.kind === 'failed' ? (
        <Button testID="retry-dispatch" label="Réessayer" onPress={dispatch} />
      ) : null}
      {cancelError ? <Text style={styles.error}>{cancelError}</Text> : null}
      <Button testID="cancel-waiting" label="Annuler" variant="secondary" onPress={() => setCancelSheetOpen(true)} disabled={cancelling} />
      <CancelRideSheet
        visible={cancelSheetOpen}
        title="Annuler la course ?"
        reasons={CLIENT_CANCEL_REASONS}
        reasonRequired={false}
        busy={cancelling}
        onConfirm={handleCancel}
        onDismiss={() => setCancelSheetOpen(false)}
      />
      </View>
    </View>
  );
}

/** Halo qui s'agrandit et s'efface en boucle, centré sur la carte (donc sur le point de départ). */
function SearchPulse() {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);
  return (
    <View style={styles.pulseLayer} pointerEvents="none" testID="search-pulse">
      <Animated.View
        style={[
          styles.pulse,
          {
            opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mapWrap: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  pulseLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulse: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: MAP_MARKER_COLORS.pickup,
  },
  card: {
    alignItems: 'center',
    gap: 12,
    padding: 20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: '#FFFFFF',
  },
  route: {
    color: '#6B7280',
  },
  payment: {
    color: '#374151',
    fontWeight: '600',
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
