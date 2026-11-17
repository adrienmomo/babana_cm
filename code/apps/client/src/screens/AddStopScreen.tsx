import React, { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MAP_MARKER_COLORS, MapView, type LatLng } from '@babana/maps';
import { Button, makeStyles, useTheme } from '@babana/ui';
import type { http } from '@babana/contracts';
import { ApiError, translateApiError } from '@babana/api-client';
import { apiClient } from '../auth';
import { PlacePicker } from '../components/PlacePicker';
import { formatMoney } from '../format';
import { labelFor } from '../placeLabel';
import type { ClientParamList, RidePoint } from '../navigation/types';
import { useKeepScreenAwake } from '../keepAwake';

/**
 * Ajouter un arrêt pendant la course (L6-21, L4-14). Deux temps, comme le serveur : désigner le
 * point (glisser la carte sous le réticule, ou rechercher), voir le nouveau prix que le serveur
 * calcule, confirmer. Aucun calcul ici (invariant 3) : le prix affiché est celui de la cotation.
 * Pas de file hors connexion : un arrêt n'existe qu'au prix que le client a vu et accepté.
 */
type Props = NativeStackScreenProps<ClientParamList, 'AddStop'>;

export function AddStopScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  useKeepScreenAwake(navigation);
  const { rideId } = route.params;
  const [center, setCenter] = useState<LatLng>(route.params.center);
  const [point, setPoint] = useState<RidePoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [quote, setQuote] = useState<http.QuoteAddedStopResponse | null>(null);
  const [busy, setBusy] = useState<'quoting' | 'confirming' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function designate(position: LatLng, label?: string) {
    setCenter(position);
    setQuote(null);
    setError(null);
    if (label) {
      setPoint({ position, label });
      return;
    }
    setGeocoding(true);
    const found = await labelFor(position);
    setGeocoding(false);
    setPoint({ position, label: found });
  }

  async function handleQuote() {
    if (!point || busy) return;
    setBusy('quoting');
    setError(null);
    try {
      const response = (await apiClient.request('quoteAddedStop', {
        pathParams: { id: rideId },
        body: { position: point.position, label: point.label.slice(0, 120) },
      })) as http.QuoteAddedStopResponse;
      setQuote(response);
    } catch (cause) {
      setError(cause instanceof ApiError ? translateApiError(cause) : 'Impossible de calculer le prix. Réessayez.');
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm() {
    if (!quote || busy) return;
    setBusy('confirming');
    setError(null);
    try {
      await apiClient.request('confirmAddedStop', { pathParams: { id: rideId }, body: { quoteId: quote.quoteId } });
      navigation.goBack();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'QUOTE_EXPIRED') {
        // Le prix vu n'est plus valable : le recalculer plutôt que d'en confirmer un autre.
        setQuote(null);
      }
      setError(cause instanceof ApiError ? translateApiError(cause) : 'Impossible d’ajouter l’arrêt. Réessayez.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.container} testID="add-stop-screen">
      <PlacePicker placeholder="Rechercher l’arrêt" onSelect={(selected) => designate(selected.position, selected.label)} />
      <View style={styles.mapWrap}>
        <MapView appearance={colors.scheme} center={center} markers={[]} onRegionChange={(c) => designate(c)} style={styles.map} />
        <View style={styles.reticle} pointerEvents="none">
          <View style={[styles.reticlePin, { backgroundColor: MAP_MARKER_COLORS.stop }]}>
            <View style={styles.reticlePinDot} />
          </View>
        </View>
        {geocoding ? <ActivityIndicator style={styles.geocoding} size="small" /> : null}
      </View>

      <Text style={styles.pointLabel} testID="add-stop-label" numberOfLines={1}>
        {point ? point.label : 'Glissez la carte jusqu’à l’arrêt'}
      </Text>

      {quote ? (
        <View style={styles.priceCard} testID="add-stop-price">
          <Text style={styles.priceLine}>Prix actuel : {formatMoney(quote.previousAmount)}</Text>
          <Text style={styles.newPrice}>Nouveau prix : {formatMoney(quote.amount)}</Text>
          <Text style={styles.priceHint}>Le chauffeur sera prévenu et l’itinéraire mis à jour.</Text>
        </View>
      ) : null}

      {error ? (
        <Text style={styles.error} testID="add-stop-error">
          {error}
        </Text>
      ) : null}

      {quote ? (
        <Button testID="add-stop-confirm" label="Confirmer l’arrêt" onPress={handleConfirm} disabled={busy !== null} />
      ) : (
        <Button testID="add-stop-quote" label="Voir le nouveau prix" onPress={handleQuote} disabled={!point || busy !== null} />
      )}
      <Button testID="add-stop-cancel" label="Annuler" variant="secondary" onPress={() => navigation.goBack()} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, gap: 8, padding: 12, backgroundColor: c.canvas },
  mapWrap: { flex: 1, minHeight: 220, borderRadius: 8, overflow: 'hidden' },
  map: { flex: 1 },
  reticle: { position: 'absolute', top: '50%', left: '50%', marginTop: -34, marginLeft: -14 },
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
    elevation: 3,
  },
  reticlePinDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.surface },
  geocoding: { position: 'absolute', top: 8, right: 8 },
  pointLabel: { color: c.ink, fontWeight: '600' },
  priceCard: { gap: 4, padding: 12, borderRadius: 8, backgroundColor: c.surfaceMuted },
  priceLine: { color: c.muted },
  newPrice: { color: c.ink, fontSize: 18, fontWeight: '700' },
  priceHint: { color: c.muted, fontSize: 13 },
  error: { color: c.dangerText },
}));
