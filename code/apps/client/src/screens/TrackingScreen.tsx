import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MapView, type LatLng, type MapMarker } from '@babana/maps';
import { StreamLivenessWatchdog, type ConnectionState } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { GENERIC_AVATAR, classLabel } from '../components/driverFormatting';
import { CallButton } from '../components/CallButton';
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
 * **Bouton d'appel du chauffeur** (D42, 2 septembre -- amoa/questions/REPONSES-2026-09-02.md
 * §1, referme l'écart `amoa/questions/L6-09.md`) : `ride.assigned` porte désormais `phoneNumber`.
 * Absent, jamais inerte (`CallButton`, même discipline que Share/Emergency) : rien ne s'affiche
 * tant que le profil chauffeur n'a pas fini de synchroniser (D30).
 *
 * **Itinéraire et « Sur place », miroirs de l'écran du chauffeur** : le chauffeur calcule le tracé
 * (vers le client, puis vers la destination) et l'affiche ; le service temps réel nous le
 * rediffuse tel quel (`ride.route`) -- les deux écrans montrent le **même** chemin, rien n'est
 * recalculé ici. `driver.arrived` (« Sur place ») prévient que le chauffeur est au point de prise
 * en charge. Les deux sont rejoués à l'abonnement `ride.track` : une reconnexion retrouve l'état.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Tracking'>;

type Phase = 'approach' | 'course';

function isDriverPositionMessage(message: realtime.ServerToClientMessage): message is realtime.DriverPositionMessage {
  return message.type === 'driver.position';
}

function isRideRouteMessage(message: realtime.ServerToClientMessage): message is realtime.RideRouteMessage {
  return message.type === 'ride.route';
}

function isDriverArrivedMessage(message: realtime.ServerToClientMessage): message is realtime.DriverArrivedMessage {
  return message.type === 'driver.arrived';
}

function isRideStartedMessage(message: realtime.ServerToClientMessage): message is realtime.RideStartedMessage {
  return message.type === 'ride.started';
}

function isRideCompletedMessage(message: realtime.ServerToClientMessage): message is realtime.RideCompletedMessage {
  return message.type === 'ride.completed';
}

function isRideTrackAckMessage(message: realtime.ServerToClientMessage): message is realtime.RideTrackAckMessage {
  return message.type === 'ride.track.ack';
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
  // Le tracé du chauffeur, tel quel : `phase` dit s'il mène au client ou à la destination.
  const [sharedRoute, setSharedRoute] = useState<{ phase: 'approach' | 'transit'; points: LatLng[] } | null>(null);
  const [driverArrived, setDriverArrived] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  // Silence de diffusion détecté par abonnement (L3-20, D47 -- amoa/questions/
  // L3-05-nearby-list-goes-silently-empty.md) : c'est précisément le risque nommé par ce défaut
  // -- `connectionState` peut rester `connected` pendant que `driver.position` s'est tu, et sans
  // ce mécanisme rien ne le distinguerait d'une course simplement calme.
  const [positionStreamStale, setPositionStreamStale] = useState(false);
  // Lu de façon synchrone dans le gestionnaire de `driver.position` -- `phase` (état React) y
  // serait périmé, l'effet ci-dessous ne s'exécutant qu'une fois (dépendances [rideId]).
  const phaseRef = useRef<Phase>('approach');

  useEffect(() => {
    ensureRealtimeConnected();
    const subscribe = () => realtimeClient.send('ride.track', { rideId });
    subscribe();

    // La cadence attendue de `driver.position` n'est plus une copie locale (D50) : le watchdog
    // n'est créé qu'à la réception de `ride.track.ack`, qui porte `broadcastIntervalMs`. Un
    // réabonnement (reconnexion, `resubscribe`) produit un nouvel accusé, donc une cadence à jour.
    let watchdog: StreamLivenessWatchdog | null = null;
    const stopWatchdog = () => {
      watchdog?.stop();
      watchdog = null;
    };

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (isRideTrackAckMessage(message)) {
        stopWatchdog();
        watchdog = new StreamLivenessWatchdog({
          expectedIntervalMs: message.payload.broadcastIntervalMs,
          onStale: () => setPositionStreamStale(true),
          onRecovered: () => setPositionStreamStale(false),
          // Réabonne sur la connexion existante -- un battement de cœur sur la connexion
          // confirmerait que tout va bien pendant qu'un flux applicatif est mort (D47), c'est
          // pourquoi la surveillance porte ici sur l'abonnement, pas sur `connectionState`.
          resubscribe: subscribe,
        });
        watchdog.start();
        return;
      }
      if (isDriverPositionMessage(message) && message.payload.rideId === rideId) {
        watchdog?.recordActivity();
        setDriverPosition(message.payload.position);
        setEtaSeconds(message.payload.etaSeconds);
        setLastPositionAt(new Date(message.emittedAt).getTime());
        if (phaseRef.current === 'course') {
          setTrace((previous) => [...previous, message.payload.position]);
        }
      } else if (isRideRouteMessage(message) && message.payload.rideId === rideId) {
        setSharedRoute({ phase: message.payload.phase, points: message.payload.points });
      } else if (isDriverArrivedMessage(message) && message.payload.rideId === rideId) {
        setDriverArrived(true);
      } else if (isRideStartedMessage(message) && message.payload.rideId === rideId) {
        phaseRef.current = 'course';
        setPhase('course');
        setTrace([]);
        setDriverArrived(false);
        // Le chemin vers le client n'a plus sa place sur la carte du trajet -- mais le tracé du
        // trajet a pu arriver AVANT ce message (rien ne les ordonne) : celui-là reste.
        setSharedRoute((current) => (current && current.phase === 'transit' ? current : null));
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
      stopWatchdog();
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

  // Le tracé du chauffeur prime ; à défaut, en course, la trace des positions reçues (un affichage,
  // pas une source de vérité). Le centre suit le chauffeur, ou à défaut le début du tracé reçu.
  const mapRoute =
    sharedRoute && sharedRoute.points.length > 1
      ? { points: sharedRoute.points }
      : phase === 'course' && trace.length > 1
        ? { points: trace }
        : undefined;
  const mapCenter: LatLng | null = driverPosition ?? sharedRoute?.points[0] ?? null;

  const markers: MapMarker[] = [
    { id: 'pickup', kind: 'pickup' as const, position: origin.position, label: 'Prise en charge' },
    { id: 'dropoff', kind: 'dropoff' as const, position: destination.position, label: 'Arrivée' },
    ...(driverPosition ? [{ id: 'driver', kind: 'driver' as const, position: driverPosition, label: driver.firstName ?? undefined }] : []),
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.phaseTitle} testID="tracking-phase">
        {phase === 'course' ? 'Course en cours' : driverArrived ? 'Votre chauffeur est arrivé' : 'Votre chauffeur arrive'}
      </Text>

      {phase === 'approach' && driverArrived ? (
        <View style={styles.arrivedBanner} testID="tracking-arrived">
          <Text style={styles.arrivedText}>Votre chauffeur est sur place. Rejoignez-le pour commencer la course.</Text>
        </View>
      ) : null}

      {disconnected ? (
        <View style={styles.connectionBanner} testID="tracking-connection-banner">
          <Text style={styles.connectionText}>
            {lastPositionAt === null
              ? 'Connexion en cours -- position pas encore reçue.'
              : `Connexion perdue -- dernière position il y a ${secondsSince(lastPositionAt)} s.`}
          </Text>
        </View>
      ) : positionStreamStale ? (
        // Silence de diffusion sur une connexion par ailleurs vivante (L3-20, D47) -- distinct du
        // bandeau ci-dessus : `connectionState` reste `connected` ici, c'est précisément le
        // risque que ce bandeau existe pour attraper. « position datée de N secondes » plutôt
        // qu'un marqueur figé ou un silence (spécification).
        <View style={styles.connectionBanner} testID="tracking-stale-banner">
          <Text style={styles.connectionText}>
            {lastPositionAt === null
              ? 'Position pas encore reçue -- nouvelle tentative en cours…'
              : `Position non mise à jour depuis ${secondsSince(lastPositionAt)} s -- nouvelle tentative en cours…`}
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
        <CallButton phoneNumber={driver.phoneNumber} />
        <ShareTripButton rideId={rideId} />
        <EmergencyButton rideId={rideId} />
      </View>

      <View style={styles.mapWrap} testID="tracking-map">
        {mapCenter ? (
          <MapView
            center={mapCenter}
            markers={markers}
            route={mapRoute}
            style={styles.map}
          />
        ) : (
          <View style={styles.mapLoading}>
            <ActivityIndicator size="large" />
            <Text style={styles.mapLoadingText}>En attente de la position du chauffeur…</Text>
          </View>
        )}
      </View>

      {!disconnected && !positionStreamStale && lastPositionAt !== null ? (
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
  arrivedBanner: {
    backgroundColor: '#DCFCE7',
    borderRadius: 8,
    padding: 10,
  },
  arrivedText: {
    color: '#166534',
    fontWeight: '600',
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
