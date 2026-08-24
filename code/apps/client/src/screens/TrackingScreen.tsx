import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MapView, type LatLng, type MapMarker } from '@babana/maps';
import type { ConnectionState } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { GENERIC_AVATAR, classLabel } from '../components/driverFormatting';
import { EmergencyButton } from '../components/EmergencyButton';
import { ShareTripButton } from '../components/ShareTripButton';
import { formatEta } from '../format';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import type { ClientParamList } from '../navigation/types';

/**
 * Suivi de course (L6-09) : voir le chauffeur arriver, puis suivre le trajet jusqu'à la fin.
 * **Affiche, ne dérive rien** (spécification) : position et ETA viennent tels quels de
 * `driver.position` (L3-09), jamais recalculés ici.
 *
 * **Partage de trajet (L8-03) et bouton d'urgence (L8-04)**, tous deux atteignables en un geste
 * depuis cet écran (24 août, amoa/questions/REPONSES-2026-08-29.md) -- l'un et l'autre n'ont de
 * sens que pendant que client et chauffeur sont réunis (`assigned`/`in_progress` côté serveur,
 * `babana_ride.py::TOGETHER_STATES`), donc pendant toute la durée où cet écran est affiché,
 * approche comme course.
 *
 * **Aucun bouton d'appel du chauffeur non plus** : la spécification en prose le demande
 * (« coordonnées du chauffeur pour l'appeler »), mais `ride.assigned` (D41) ne porte aucun numéro
 * -- ni lui ni aucun autre message serveur à destination du client. Un écart, pas un oubli
 * d'écran : voir `amoa/questions/L6-09.md`.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Tracking'>;

type Phase = 'approach' | 'course';

function isDriverPositionMessage(message: realtime.ServerToClientMessage): message is realtime.DriverPositionMessage {
  return message.type === 'driver.position';
}

function isRideStartedMessage(message: realtime.ServerToClientMessage): message is realtime.RideStartedMessage {
  return message.type === 'ride.started';
}

function isRideCompletedMessage(message: realtime.ServerToClientMessage): message is realtime.RideCompletedMessage {
  return message.type === 'ride.completed';
}

function secondsSince(at: number): number {
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

export function TrackingScreen({ route, navigation }: Props) {
  const { rideId, origin, destination, driver } = route.params;

  const [phase, setPhase] = useState<Phase>('approach');
  const [driverPosition, setDriverPosition] = useState<LatLng | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [lastPositionAt, setLastPositionAt] = useState<number | null>(null);
  const [trace, setTrace] = useState<LatLng[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  // Lu de façon synchrone dans le gestionnaire de `driver.position` -- `phase` (état React) y
  // serait périmé, l'effet ci-dessous ne s'exécutant qu'une fois (dépendances [rideId]).
  const phaseRef = useRef<Phase>('approach');

  useEffect(() => {
    ensureRealtimeConnected();
    const subscribe = () => realtimeClient.send('ride.track', { rideId });
    subscribe();

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (isDriverPositionMessage(message) && message.payload.rideId === rideId) {
        setDriverPosition(message.payload.position);
        setEtaSeconds(message.payload.etaSeconds);
        setLastPositionAt(new Date(message.emittedAt).getTime());
        if (phaseRef.current === 'course') {
          setTrace((previous) => [...previous, message.payload.position]);
        }
      } else if (isRideStartedMessage(message) && message.payload.rideId === rideId) {
        phaseRef.current = 'course';
        setPhase('course');
        setTrace([]);
      } else if (isRideCompletedMessage(message) && message.payload.rideId === rideId) {
        // Le résumé de fin affiche exactement ce que le serveur a écrit dans ce message -- jamais
        // une distance ou une durée reconstituée depuis les positions accumulées ci-dessus, qui
        // ne sont qu'un affichage, pas une source de vérité (spécification, "ce qu'un client
        // relira en cas de litige").
        navigation.replace('RideSummary', {
          rideId,
          distanceMeters: message.payload.distanceMeters,
          durationSeconds: message.payload.durationSeconds,
          amount: message.payload.amount,
          breakdown: message.payload.breakdown,
        });
      }
    });

    // Coupure puis reconnexion (le cas courant, CLAUDE.md) : ride.track n'a pas de politique de
    // rejeu automatique côté client (pas d'abonnement mémorisé comme nearby.subscribe) --
    // réémis explicitement ici à chaque connexion rétablie, sans quoi le suivi se fige
    // silencieusement après la moindre coupure.
    const unsubscribeConnectionState = onRealtimeConnectionStateChange((state) => {
      setConnectionState(state);
      if (state === 'connected') subscribe();
    });

    return () => {
      unsubscribeMessages();
      unsubscribeConnectionState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId]);

  // Un tick par seconde pour rafraîchir « il y a N s » -- même mécanisme que le compte à rebours
  // de WaitingScreen.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const gamme = classLabel(driver.motorcycleClass);
  const disconnected = connectionState !== 'connected';

  const markers: MapMarker[] = [
    { id: 'pickup', kind: 'pickup' as const, position: origin.position, label: 'Prise en charge' },
    { id: 'dropoff', kind: 'dropoff' as const, position: destination.position, label: 'Arrivée' },
    ...(driverPosition ? [{ id: 'driver', kind: 'driver' as const, position: driverPosition, label: driver.firstName ?? undefined }] : []),
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.phaseTitle} testID="tracking-phase">
        {phase === 'approach' ? 'Votre chauffeur arrive' : 'Course en cours'}
      </Text>

      {disconnected ? (
        <View style={styles.connectionBanner} testID="tracking-connection-banner">
          <Text style={styles.connectionText}>
            {lastPositionAt === null
              ? 'Connexion en cours -- position pas encore reçue.'
              : `Connexion perdue -- dernière position il y a ${secondsSince(lastPositionAt)} s.`}
          </Text>
        </View>
      ) : null}

      <View style={styles.driverCard} testID="tracking-driver-card">
        <Image source={{ uri: driver.photoUrl ?? GENERIC_AVATAR }} style={styles.avatar} accessibilityIgnoresInvertColors />
        <View style={styles.driverInfo}>
          <Text style={styles.driverName}>{driver.firstName ?? 'Votre chauffeur'}</Text>
          <Text style={styles.driverMeta} testID="tracking-plate">
            {gamme ? `${gamme} · ` : ''}
            {driver.licensePlate ?? 'Immatriculation indisponible'}
          </Text>
        </View>
        {phase === 'approach' && etaSeconds !== null ? (
          <Text style={styles.eta} testID="tracking-eta">
            {formatEta(etaSeconds)}
          </Text>
        ) : null}
      </View>

      <View style={styles.actionsRow} testID="tracking-actions">
        <ShareTripButton rideId={rideId} />
        <EmergencyButton rideId={rideId} />
      </View>

      <View style={styles.mapWrap} testID="tracking-map">
        {driverPosition ? (
          <MapView
            center={driverPosition}
            markers={markers}
            route={phase === 'course' && trace.length > 1 ? { points: trace } : undefined}
            style={styles.map}
          />
        ) : (
          <View style={styles.mapLoading}>
            <ActivityIndicator size="large" />
            <Text style={styles.mapLoadingText}>En attente de la position du chauffeur…</Text>
          </View>
        )}
      </View>

      {!disconnected && lastPositionAt !== null ? (
        <Text style={styles.freshness} testID="tracking-freshness">
          Position mise à jour il y a {secondsSince(lastPositionAt)} s
        </Text>
      ) : null}

      <View style={styles.pointsSummary}>
        <Text style={styles.pointText} numberOfLines={1}>
          Départ : {origin.label}
        </Text>
        <Text style={styles.pointText} numberOfLines={1}>
          Arrivée : {destination.label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 8,
    padding: 12,
  },
  phaseTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  connectionBanner: {
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 8,
  },
  connectionText: {
    color: '#92400E',
  },
  driverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E5E7EB',
  },
  driverInfo: {
    flex: 1,
    gap: 2,
  },
  driverName: {
    fontWeight: '600',
  },
  driverMeta: {
    fontSize: 12,
    color: '#6B7280',
  },
  eta: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0A7D3D',
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
  },
  mapWrap: {
    flex: 1,
    minHeight: 220,
    borderRadius: 8,
    overflow: 'hidden',
  },
  map: {
    flex: 1,
  },
  mapLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F9FAFB',
  },
  mapLoadingText: {
    color: '#6B7280',
  },
  freshness: {
    fontSize: 12,
    color: '#6B7280',
  },
  pointsSummary: {
    gap: 4,
  },
  pointText: {
    color: '#374151',
  },
});
