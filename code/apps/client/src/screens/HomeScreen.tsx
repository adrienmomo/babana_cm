import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MapView, reverseGeocode, type LatLng, type MapMarker } from '@babana/maps';
import { Button } from '@babana/ui';
import type { http, realtime } from '@babana/contracts';
import { PlacePicker } from '../components/PlacePicker';
import { DriverMarker } from '../components/DriverMarker';
import { getCurrentPosition, type LocationFailureReason } from '../location';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import type { ClientParamList, RidePoint } from '../navigation/types';

/**
 * Écran d'accueil (L6-06) : la carte, les 5 chauffeurs proches, la désignation du départ et de
 * l'arrivée. Premier écran métier réel de l'app -- il sert de patron aux quatorze suivants
 * (L6-07 à L6-17), voir le rapport de nuit pour ce qui y reste fragile.
 */

// Douala, aucune permission de localisation nécessaire pour l'afficher -- même point que
// nearbyDriversQueryExample (@babana/contracts), pas une valeur inventée pour cet écran.
const DOUALA_DEFAULT_CENTER: LatLng = { latitude: 4.0511, longitude: 9.7679 };

// Rayon de la première demande de chauffeurs proches -- le serveur le plafonne de toute façon
// (L3-05, critère 1) ; valeur choisie pour une ville comme Douala, pas une constante du contrat.
// Choix d'implémentation non spécifié, à ajuster si L6-17 (mesure batterie/données) le juge trop
// large.
const NEARBY_SUBSCRIBE_RADIUS_METERS = 5000;

type ActiveSlot = 'departure' | 'arrival';

type Props = NativeStackScreenProps<ClientParamList, 'Home'>;

function isNearbyDriversMessage(message: realtime.ServerToClientMessage): message is realtime.NearbyDriversMessage {
  return message.type === 'nearby.drivers';
}

function isNearbySubscribeAckMessage(
  message: realtime.ServerToClientMessage
): message is realtime.NearbySubscribeAckMessage {
  return message.type === 'nearby.subscribe.ack';
}

// Doute L6-06 §1 (amoa/questions/REPONSES-2026-08-23.md §2) : hors des grands axes, le géocodage
// inverse ne répond jamais "je ne sais pas" -- il rend le repère connu le plus proche, qui peut
// être à plusieurs centaines de mètres du réticule. Le libellé se présente donc sous une forme
// qui dit son approximation plutôt que le nom seul ; l'interface rappelle par ailleurs (JSX
// ci-dessous) que c'est le point sur la carte qui fait foi, pas le texte.
async function labelFor(position: LatLng): Promise<string> {
  // L'échec du géocodage inverse (Odoo/Google indisponible) ne doit jamais empêcher de désigner
  // un point -- les coordonnées elles-mêmes restent la vérité, seul le libellé se dégrade.
  const label = await reverseGeocode(position).catch(() => null);
  return label ? `vers ${label}` : `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`;
}

// Doute L6-06 §2 : les trois causes ne se règlent pas de la même façon, le message ne doit plus
// les confondre. Le départ reste désignable à la main dans les trois cas (spécification).
const LOCATION_ERROR_MESSAGES: Record<LocationFailureReason, string> = {
  'permission-denied':
    'Localisation refusée. Autorisez-la dans les réglages du téléphone, ou désignez votre départ sur la carte.',
  'position-unavailable':
    'Position indisponible pour le moment. Vérifiez que le GPS est activé, ou désignez votre départ sur la carte.',
  timeout: 'La localisation prend du temps. Réessayez, ou désignez votre départ sur la carte.',
};

export function HomeScreen({ navigation }: Props) {
  const [region, setRegion] = useState<LatLng>(DOUALA_DEFAULT_CENTER);
  const [activeSlot, setActiveSlot] = useState<ActiveSlot>('departure');
  const [departure, setDeparture] = useState<RidePoint | null>(null);
  const [arrival, setArrival] = useState<RidePoint | null>(null);
  const [locating, setLocating] = useState(true);
  const [locationError, setLocationError] = useState<LocationFailureReason | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [nearbyDrivers, setNearbyDrivers] = useState<readonly http.NearbyDriver[]>([]);
  // Accusé de réception d'un abonnement refusé pour limitation de débit (doute L6-06 §3) --
  // distinct de "aucun chauffeur à proximité" (nearbyDrivers vide), qui reste un état légitime.
  const [subscribeRefusal, setSubscribeRefusal] = useState<{ retryAfterMs: number } | null>(null);
  // Un abonnement en vol par point de départ (critère 3, mis à jour en direct) -- un identifiant
  // croissant écarte la réponse d'un abonnement déjà remplacé, même raison que PlacePicker pour
  // une recherche texte abandonnée.
  const subscriptionRequest = useRef(0);

  // --- Position du client au chargement (D22 : aucune capture ponctuelle n'existait avant ce
  // soir) -- échec géré sans bloquer l'écran (spécification) : la carte reste sur Douala, le
  // départ reste à désigner à la main. Factorisée pour être rejouable depuis le bouton
  // "Réessayer" de la bannière d'échec (doute L6-06 §2).
  async function loadCurrentPosition(onCancelled: () => boolean) {
    setLocating(true);
    const result = await getCurrentPosition();
    if (onCancelled()) return;
    setLocating(false);
    if (result.status === 'error') {
      setLocationError(result.reason);
      return;
    }
    setLocationError(null);
    setRegion(result.position);
    setGeocoding(true);
    const label = await labelFor(result.position);
    if (onCancelled()) return;
    setGeocoding(false);
    setDeparture({ position: result.position, label });
    setActiveSlot('arrival');
  }

  useEffect(() => {
    let cancelled = false;
    loadCurrentPosition(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Chauffeurs proches, mis à jour en direct (critère 3) -- recentré sur le départ dès qu'il
  // change (position GPS initiale, glissement de carte, ou recherche), pas sur la position brute
  // du téléphone : c'est là que le chauffeur doit venir chercher le client. Délibérément indexé
  // sur la position du départ seule (voir le tableau de dépendances plus bas) : `region` bouge à
  // chaque glissement de carte pour l'arrivée aussi, ce qui ne doit jamais redéclencher un
  // abonnement.
  useEffect(() => {
    const center = departure?.position ?? region;
    ensureRealtimeConnected();
    const thisRequest = ++subscriptionRequest.current;
    const subscribe = () =>
      realtimeClient.send('nearby.subscribe', { position: center, radiusMeters: NEARBY_SUBSCRIBE_RADIUS_METERS });
    subscribe();

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (subscriptionRequest.current !== thisRequest) return;
      if (isNearbyDriversMessage(message)) {
        setNearbyDrivers(message.payload.drivers);
        setSubscribeRefusal(null);
      } else if (isNearbySubscribeAckMessage(message)) {
        setSubscribeRefusal(message.payload.accepted ? null : { retryAfterMs: message.payload.retryAfterMs });
      }
    });
    // Une reconnexion (coupure réseau, le cas courant) rouvre le socket sans mémoire de cet
    // abonnement -- le réémettre à chaque connexion établie, pas seulement à la première, sans
    // quoi la liste des chauffeurs proches se fige silencieusement après la moindre coupure.
    const unsubscribeConnectionState = onRealtimeConnectionStateChange((state) => {
      if (state === 'connected') subscribe();
    });

    return () => {
      unsubscribeMessages();
      unsubscribeConnectionState();
      realtimeClient.send('nearby.unsubscribe', {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departure?.position.latitude, departure?.position.longitude]);

  // --- Déplacement de la carte sous le réticule fixe (premier des deux moyens de désignation,
  // prioritaire -- spécification L6-06). Le géocodage inverse se déclenche ici, au relâchement du
  // geste : `onRegionChange` du fournisseur de carte (`packages/maps/src/providers/google/
  // MapView.tsx`) est déjà branché sur `onRegionChangeComplete`, jamais sur un événement par
  // frame -- un appel par frame enverrait des centaines de requêtes REST pour un seul geste, sur
  // un forfait de données compté.
  async function handleRegionChange(center: LatLng) {
    setRegion(center);
    setGeocoding(true);
    const label = await labelFor(center);
    setGeocoding(false);
    applyToActiveSlot({ position: center, label });
  }

  function applyToActiveSlot(point: RidePoint) {
    if (activeSlot === 'departure') {
      setDeparture(point);
    } else {
      setArrival(point);
    }
  }

  function handlePlaceSelected(point: RidePoint) {
    setRegion(point.position);
    applyToActiveSlot(point);
  }

  function handleNext() {
    if (!departure || !arrival) return;
    navigation.navigate('Quote', {
      origin: departure,
      destination: arrival,
      nearbyDrivers,
      excludedDriverIds: [],
      rejectionStreak: 0,
    });
  }

  function retrySubscription() {
    // Renvoie le même abonnement, sans changer `subscriptionRequest.current` -- la réponse reste
    // acceptée par le filtre de l'effet ci-dessus, aucun nouvel abonnement à ouvrir pour ça.
    const center = departure?.position ?? region;
    realtimeClient.send('nearby.subscribe', { position: center, radiusMeters: NEARBY_SUBSCRIBE_RADIUS_METERS });
  }

  function retryLocation() {
    loadCurrentPosition(() => false);
  }

  const markers: MapMarker[] = [
    ...(departure ? [{ id: 'pickup', kind: 'pickup' as const, position: departure.position, label: 'Départ' }] : []),
    ...(arrival ? [{ id: 'dropoff', kind: 'dropoff' as const, position: arrival.position, label: 'Arrivée' }] : []),
    ...nearbyDrivers.map((driver) => ({
      id: driver.driverId,
      kind: 'driver' as const,
      position: driver.position,
      label: driver.firstName ?? undefined,
    })),
  ];

  return (
    <View style={styles.container}>
      <View style={styles.pointsRow}>
        <PointButton
          testID="departure-slot"
          title="Départ"
          value={locating ? 'Localisation…' : (departure?.label ?? 'Glissez la carte ou recherchez')}
          active={activeSlot === 'departure'}
          onPress={() => setActiveSlot('departure')}
        />
        <PointButton
          testID="arrival-slot"
          title="Arrivée"
          value={arrival?.label ?? 'Où allez-vous ?'}
          active={activeSlot === 'arrival'}
          onPress={() => setActiveSlot('arrival')}
        />
      </View>

      {locationError ? (
        <View style={styles.locationErrorBanner} testID="location-error">
          <Text style={styles.locationErrorText}>{LOCATION_ERROR_MESSAGES[locationError]}</Text>
          <Button testID="retry-location" label="Réessayer" variant="secondary" onPress={retryLocation} />
        </View>
      ) : null}

      <PlacePicker
        key={activeSlot}
        placeholder={activeSlot === 'departure' ? 'Rechercher le point de départ' : 'Rechercher la destination'}
        onSelect={handlePlaceSelected}
      />

      <View style={styles.mapWrap}>
        <MapView center={region} markers={markers} onRegionChange={handleRegionChange} style={styles.map} />
        <View style={styles.reticle} pointerEvents="none" testID="reticle">
          <Text style={styles.reticleGlyph}>📍</Text>
        </View>
        {geocoding ? <ActivityIndicator style={styles.geocoding} size="small" /> : null}
      </View>
      {/* Doute L6-06 §1 : le libellé du géocodage inverse est une approximation, jamais un fait
          -- ce rappel reste visible en permanence, pas seulement pendant le géocodage. */}
      <Text style={styles.mapTruthHint}>📍 C’est le point sur la carte qui fait foi, le libellé n’est qu’une indication.</Text>

      <View style={styles.driversSection}>
        {subscribeRefusal ? (
          <View style={styles.noDrivers} testID="subscribe-refused">
            <Text style={styles.noDriversText}>
              {`Votre demande n’a pas été prise en compte, patientez ${Math.ceil(subscribeRefusal.retryAfterMs / 1000)} s avant de réessayer.`}
            </Text>
            <Button testID="retry-nearby" label="Réessayer" variant="secondary" onPress={retrySubscription} />
          </View>
        ) : nearbyDrivers.length === 0 ? (
          <View style={styles.noDrivers}>
            <Text style={styles.noDriversText}>Aucun chauffeur disponible pour l’instant.</Text>
            <Button testID="retry-nearby" label="Réessayer" variant="secondary" onPress={retrySubscription} />
          </View>
        ) : (
          <FlatList
            horizontal
            data={nearbyDrivers}
            keyExtractor={(driver) => driver.driverId}
            renderItem={({ item }) => <DriverMarker driver={item} />}
            contentContainerStyle={styles.driversList}
            showsHorizontalScrollIndicator={false}
          />
        )}
      </View>

      <Button testID="next-button" label="Suivant" onPress={handleNext} disabled={!departure || !arrival} />
    </View>
  );
}

function PointButton({
  testID,
  title,
  value,
  active,
  onPress,
}: {
  testID: string;
  title: string;
  value: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.pointButton, active ? styles.pointButtonActive : null]}
    >
      <Text style={styles.pointTitle}>{title}</Text>
      <Text style={styles.pointValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 8,
    padding: 12,
  },
  pointsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pointButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 8,
  },
  pointButtonActive: {
    borderColor: '#0A7D3D',
    backgroundColor: '#ECFDF5',
  },
  locationErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 8,
  },
  locationErrorText: {
    flex: 1,
    color: '#92400E',
  },
  mapTruthHint: {
    fontSize: 12,
    color: '#6B7280',
  },
  pointTitle: {
    fontSize: 12,
    color: '#6B7280',
  },
  pointValue: {
    fontWeight: '600',
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
  reticle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -24,
    marginLeft: -12,
  },
  reticleGlyph: {
    fontSize: 24,
  },
  geocoding: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  driversSection: {
    minHeight: 96,
  },
  driversList: {
    gap: 8,
  },
  noDrivers: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  noDriversText: {
    color: '#374151',
  },
});
