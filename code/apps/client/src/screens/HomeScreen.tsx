import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MAP_MARKER_COLORS, MapView, type LatLng, type MapMarker } from '@babana/maps';
import { labelFor } from '../placeLabel';
import { Button, makeStyles, useTheme } from '@babana/ui';
import type { http, realtime } from '@babana/contracts';
import { StreamLivenessWatchdog } from '@babana/api-client';
import { PlacePicker } from '../components/PlacePicker';
import { RecentDestinations } from '../components/RecentDestinations';
import { getCurrentPosition, type LocationFailureReason } from '../location';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import type { ClientParamList, RidePoint } from '../navigation/types';
import { useKeepScreenAwake } from '../keepAwake';

/**
 * Écran d'accueil (L6-06) : la carte, les chauffeurs proches, la désignation du départ et de
 * l'arrivée. Les chauffeurs sont des points anonymes sur la carte, avec leur nombre : le client ne
 * choisit pas son chauffeur -- la course part au plus proche disponible, choisi par le serveur
 * (D10 retiré). Il voit seulement qu'il y a du monde autour avant de commander. Premier écran métier réel de l'app -- il sert de patron aux quatorze suivants
 * (L6-07 à L6-17), voir le rapport de nuit pour ce qui y reste fragile.
 */

// Douala, aucune permission de localisation nécessaire pour l'afficher -- même point que
// nearbyDriversQueryExample (@babana/contracts), pas une valeur inventée pour cet écran.
const DOUALA_DEFAULT_CENTER: LatLng = { latitude: 4.0511, longitude: 9.7679 };

// `stop-N` : N-ième arrêt intermédiaire (L6-21), désigné comme départ et arrivée -- au réticule.
type ActiveSlot = 'departure' | 'arrival' | `stop-${number}`;

function stopIndexOf(slot: ActiveSlot): number | null {
  return slot.startsWith('stop-') ? Number(slot.slice(5)) : null;
}

type Props = NativeStackScreenProps<ClientParamList, 'Home'>;

function isNearbyDriversMessage(message: realtime.ServerToClientMessage): message is realtime.NearbyDriversMessage {
  return message.type === 'nearby.drivers';
}

function isNearbySubscribeAckMessage(
  message: realtime.ServerToClientMessage
): message is realtime.NearbySubscribeAckMessage {
  return message.type === 'nearby.subscribe.ack';
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
  const styles = useStyles();
  const { colors } = useTheme();
  // Décision du 14 novembre : l'écran ne s'éteint pas tant qu'une carte est ouverte.
  useKeepScreenAwake(navigation);
  const [region, setRegion] = useState<LatLng>(DOUALA_DEFAULT_CENTER);
  const [activeSlot, setActiveSlot] = useState<ActiveSlot>('departure');
  const [departure, setDeparture] = useState<RidePoint | null>(null);
  const [arrival, setArrival] = useState<RidePoint | null>(null);
  // Arrêts intermédiaires (L6-21). Leur nombre maximal est une règle serveur : au-delà, le devis
  // répond TOO_MANY_STOPS et l'écran d'estimation le dit -- aucune limite recopiée ici.
  const [stops, setStops] = useState<RidePoint[]>([]);
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
    // `excludeDriverIds` toujours vide ici (L3-08, 24 août) : cet écran ne porte aucune course,
    // donc aucun refusant -- une liste vide est aussi le signal qui garde cette découverte libre
    // strictement bornée par NEARBY_MAX_RADIUS_METERS côté service, jamais élargie (C2b).
    const subscribe = () =>
      realtimeClient.send('nearby.subscribe', { position: center, excludeDriverIds: [] });
    subscribe();

    // Surveillance de silence (L3-20) : par abonnement, pas par connexion (D47) -- un battement
    // de cœur sur la connexion arriverait normalement pendant qu'un flux applicatif est mort,
    // exactement la cause racine du 30 août. La cadence attendue n'est plus une copie locale
    // (D50) : le watchdog n'est créé qu'à la réception de `nearby.subscribe.ack`, qui porte
    // `broadcastIntervalMs` -- l'app apprend du serveur à quel rythme les messages arrivent.
    // Silencieuse depuis le 24 octobre (demande produit) : plus de bandeau « liste non mise à
    // jour », seulement le réabonnement, et la dernière liste connue reste affichée.
    let watchdog: StreamLivenessWatchdog | null = null;
    const stopWatchdog = () => {
      watchdog?.stop();
      watchdog = null;
    };
    // Un abonnement refusé (limitation de débit) est réessayé seul, au délai annoncé par le
    // serveur : il n'y a plus de bouton « Réessayer » pour le faire.
    let refusalRetry: ReturnType<typeof setTimeout> | null = null;
    const cancelRefusalRetry = () => {
      if (refusalRetry) clearTimeout(refusalRetry);
      refusalRetry = null;
    };

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (subscriptionRequest.current !== thisRequest) return;
      if (isNearbyDriversMessage(message)) {
        watchdog?.recordActivity();
        setNearbyDrivers(message.payload.drivers);
        setSubscribeRefusal(null);
      } else if (isNearbySubscribeAckMessage(message)) {
        if (!message.payload.accepted) {
          setSubscribeRefusal({ retryAfterMs: message.payload.retryAfterMs });
          cancelRefusalRetry();
          refusalRetry = setTimeout(subscribe, message.payload.retryAfterMs);
          return;
        }
        setSubscribeRefusal(null);
        // (Re)démarre la surveillance à la cadence que le serveur vient d'annoncer -- un
        // réabonnement (reconnexion, silence, refus) produit un nouvel accusé, donc une
        // cadence à jour, jamais une valeur supposée figée.
        stopWatchdog();
        watchdog = new StreamLivenessWatchdog({
          expectedIntervalMs: message.payload.broadcastIntervalMs,
          onStale: () => {},
          onRecovered: () => {},
          // Réabonne sur la connexion existante -- la cause racine du 30 août était un abonnement
          // mort sur une connexion par ailleurs vivante, pas une connexion tombée.
          resubscribe: subscribe,
        });
        watchdog.start();
      }
    });
    // Une reconnexion (coupure réseau, le cas courant) rouvre le socket sans mémoire de cet
    // abonnement -- le réémettre à chaque connexion établie, pas seulement à la première, sans
    // quoi la liste des chauffeurs proches se fige silencieusement après la moindre coupure.
    const unsubscribeConnectionState = onRealtimeConnectionStateChange((state) => {
      if (state === 'connected') subscribe();
    });

    return () => {
      stopWatchdog();
      cancelRefusalRetry();
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
    const stopIndex = stopIndexOf(activeSlot);
    if (stopIndex !== null) {
      setStops((current) => current.map((stop, index) => (index === stopIndex ? point : stop)));
    } else if (activeSlot === 'departure') {
      setDeparture(point);
    } else {
      setArrival(point);
    }
  }

  // Un arrêt naît au centre de la carte, déjà désigné : le geste qui l'ajuste est celui du départ
  // et de l'arrivée (glisser la carte sous le réticule), jamais une adresse à saisir.
  async function addStop() {
    const index = stops.length;
    const label = await labelFor(region);
    setStops((current) => [...current, { position: region, label }]);
    setActiveSlot(`stop-${index}`);
  }

  function removeStop(index: number) {
    setStops((current) => current.filter((_stop, i) => i !== index));
    setActiveSlot('arrival');
    if (arrival) setRegion(arrival.position);
  }

  function moveStop(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= stops.length) return;
    setStops((current) => {
      const next = [...current];
      const moved = next[index];
      const other = next[target];
      if (!moved || !other) return current;
      next[index] = other;
      next[target] = moved;
      return next;
    });
    setActiveSlot('arrival');
  }

  // Toucher « Départ » ou « Arrivée » amène la carte sur ce point (15 novembre) : le réticule s'y
  // pose, à sa couleur, et l'autre point garde son épingle. Avant, la carte restait où elle était
  // et le réticule recouvrait l'autre point -- le moindre glissement l'écrasait. Un point pas encore
  // désigné laisse la carte où elle est. Le recentrage est programmé : il n'est jamais relayé comme
  // une désignation (`onRegionChange` ne remonte qu'un geste du doigt, @babana/maps).
  function activateSlot(slot: ActiveSlot) {
    setActiveSlot(slot);
    const stopIndex = stopIndexOf(slot);
    const point = stopIndex !== null ? stops[stopIndex] : slot === 'departure' ? departure : arrival;
    if (point) setRegion(point.position);
  }

  function handlePlaceSelected(point: RidePoint) {
    setRegion(point.position);
    applyToActiveSlot(point);
  }

  function handleNext() {
    if (!departure || !arrival) return;
    navigation.navigate('Quote', { origin: departure, destination: arrival, ...(stops.length ? { stops } : {}) });
  }

  function retryLocation() {
    loadCurrentPosition(() => false);
  }

  // Le point en cours de désignation est représenté par le réticule, pas par une épingle : il est
  // sous le réticule par construction, et les deux se superposaient (24 octobre). L'autre point
  // garde toujours son épingle, à sa couleur (15 novembre : le réticule ne la remplace plus, même
  // quand la carte est encore centrée dessus).
  const markers: MapMarker[] = [
    ...(departure && activeSlot !== 'departure'
      ? [{ id: 'pickup', kind: 'pickup' as const, position: departure.position, label: 'Départ' }]
      : []),
    ...(arrival && activeSlot !== 'arrival'
      ? [{ id: 'dropoff', kind: 'dropoff' as const, position: arrival.position, label: 'Arrivée' }]
      : []),
    ...stops
      .map((stop, index) => ({ stop, index }))
      .filter(({ index }) => activeSlot !== `stop-${index}`)
      .map(({ stop, index }) => ({ id: `stop-${index}`, kind: 'stop' as const, position: stop.position, label: `Arrêt ${index + 1}` })),
    // Anonymes : le serveur n'envoie qu'une position et une distance (ni identifiant, ni prénom)
    // -- un point par chauffeur disponible, repéré par son rang.
    ...nearbyDrivers.map((driver, index) => ({
      id: `nearby-${index}`,
      kind: 'driver' as const,
      position: driver.position,
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
          onPress={() => activateSlot('departure')}
        />
        <PointButton
          testID="arrival-slot"
          title="Arrivée"
          value={arrival?.label ?? 'Où allez-vous ?'}
          active={activeSlot === 'arrival'}
          onPress={() => activateSlot('arrival')}
        />
      </View>

      {stops.map((stop, index) => (
        <View key={`stop-${index}`} style={styles.stopRow} testID={`stop-row-${index}`}>
          <PointButton
            testID={`stop-slot-${index}`}
            title={`Arrêt ${index + 1}`}
            value={stop.label}
            active={activeSlot === `stop-${index}`}
            onPress={() => activateSlot(`stop-${index}`)}
          />
          <Pressable testID={`stop-up-${index}`} accessibilityLabel="Monter l’arrêt" onPress={() => moveStop(index, -1)} style={styles.stopAction} disabled={index === 0}>
            <Text style={[styles.stopActionText, index === 0 ? styles.stopActionDisabled : null]}>↑</Text>
          </Pressable>
          <Pressable testID={`stop-down-${index}`} accessibilityLabel="Descendre l’arrêt" onPress={() => moveStop(index, 1)} style={styles.stopAction} disabled={index === stops.length - 1}>
            <Text style={[styles.stopActionText, index === stops.length - 1 ? styles.stopActionDisabled : null]}>↓</Text>
          </Pressable>
          <Pressable testID={`stop-remove-${index}`} accessibilityLabel="Retirer l’arrêt" onPress={() => removeStop(index)} style={styles.stopAction}>
            <Text style={styles.stopActionText}>✕</Text>
          </Pressable>
        </View>
      ))}

      {departure && arrival ? (
        <Pressable testID="add-stop" accessibilityRole="button" onPress={addStop} style={styles.addStop}>
          <Text style={styles.addStopText}>+ Ajouter un arrêt</Text>
        </Pressable>
      ) : null}

      {locationError ? (
        <View style={styles.locationErrorBanner} testID="location-error">
          <Text style={styles.locationErrorText}>{LOCATION_ERROR_MESSAGES[locationError]}</Text>
          <Button testID="retry-location" label="Réessayer" variant="secondary" onPress={retryLocation} />
        </View>
      ) : null}

      <PlacePicker
        key={activeSlot}
        placeholder={
          activeSlot === 'departure'
            ? 'Rechercher le point de départ'
            : stopIndexOf(activeSlot) !== null
              ? 'Rechercher l’arrêt'
              : 'Rechercher la destination'
        }
        onSelect={handlePlaceSelected}
      />

      {/* Trajets habituels : un geste au lieu d'une recherche, pendant le choix de l'arrivée. */}
      {activeSlot === 'arrival' ? <RecentDestinations onSelect={handlePlaceSelected} /> : null}

      <View style={styles.mapWrap}>
        <MapView appearance={colors.scheme} center={region} markers={markers} onRegionChange={handleRegionChange} style={styles.map} />
        {/* Réticule = l'épingle du point en cours de désignation, à la couleur de son rôle (même
            palette que les épingles de la carte) ; sa pointe marque le centre exact de la carte. */}
        <View style={styles.reticle} pointerEvents="none" testID="reticle">
          <View
            testID="reticle-pin"
            style={[
              styles.reticlePin,
              {
                backgroundColor:
                  activeSlot === 'departure'
                    ? MAP_MARKER_COLORS.pickup
                    : stopIndexOf(activeSlot) !== null
                      ? MAP_MARKER_COLORS.stop
                      : MAP_MARKER_COLORS.dropoff,
              },
            ]}
          >
            <View style={styles.reticlePinDot} />
          </View>
        </View>
        {geocoding ? <ActivityIndicator style={styles.geocoding} size="small" /> : null}
      </View>

      <View style={styles.driversSection}>
        {/* 24 octobre : aucun message quand personne n'est à proximité, aucun bouton
            « Réessayer » -- les points sur la carte suffisent, et le réabonnement est automatique. */}
        {subscribeRefusal ? (
          <Text style={styles.noDriversText} testID="subscribe-refused">
            {`Votre demande n’a pas été prise en compte, nouvelle tentative dans ${Math.ceil(subscribeRefusal.retryAfterMs / 1000)} s.`}
          </Text>
        ) : nearbyDrivers.length === 0 ? null : (
          // Maquette produit (25 octobre) : le libellé à gauche, la pastille « N en ligne » à droite.
          <View style={styles.driversRow} testID="nearby-count">
            <Text style={styles.driversLabel}>{nearbyDrivers.length === 1 ? 'Moto disponible' : 'Motos disponibles'}</Text>
            <View style={styles.onlineBadge}>
              <View style={styles.onlineDot} testID="nearby-online-dot" />
              <Text style={styles.onlineText}>{`${nearbyDrivers.length} en ligne`}</Text>
            </View>
          </View>
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
  const styles = useStyles();
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

const useStyles = makeStyles((c) => ({
  container: {
    flex: 1,
    gap: 8,
    padding: 12,
  },
  pointsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stopAction: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stopActionText: {
    color: c.ink,
    fontSize: 18,
  },
  stopActionDisabled: {
    color: c.subtle,
  },
  addStop: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  addStopText: {
    color: c.brandText,
    fontWeight: '600',
  },
  pointButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 8,
    padding: 8,
  },
  pointButtonActive: {
    borderColor: c.brand,
    backgroundColor: c.brandSoft,
  },
  locationErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: c.warningSoft,
    borderRadius: 8,
    padding: 8,
  },
  locationErrorText: {
    flex: 1,
    color: c.warningText,
  },
  pointTitle: {
    fontSize: 12,
    color: c.muted,
  },
  pointValue: {
    color: c.ink,
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
  // Épingle en goutte : un carré aux coins arrondis sauf un, tourné de 45° -- le coin pointu, en
  // bas, tombe exactement sur le centre de la carte : 14 (demi-côté) + 28 * 1.41 / 2 (demi-
  // diagonale) ~ 34 sous le haut de la boîte.
  reticle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -34,
    marginLeft: -14,
  },
  reticlePin: {
    width: 28,
    height: 28,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 0,
    borderWidth: 2,
    borderColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
    shadowColor: c.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  reticlePinDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: c.surface,
  },
  geocoding: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  driversSection: {
    minHeight: 40,
    justifyContent: 'center',
  },
  driversRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: c.surfaceMuted,
  },
  driversLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: c.ink,
  },
  onlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // Même vert que les repères chauffeur de la carte (MAP_MARKER_COLORS.driver).
  onlineDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: MAP_MARKER_COLORS.driver,
  },
  onlineText: {
    fontSize: 17,
    fontWeight: '700',
    color: MAP_MARKER_COLORS.driver,
  },
  noDriversText: {
    textAlign: 'center',
    color: c.inkSoft,
  },
}));
