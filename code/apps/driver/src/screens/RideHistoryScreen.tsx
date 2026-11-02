import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { StarRating } from '@babana/ui';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';
import { formatMoney, formatRideDate } from '../format';
import { buttonLabels, buttons, colors, radius } from '../theme';
import type { DriverParamList } from '../navigation/types';

/**
 * « Mes courses » du chauffeur (2 novembre) : ses courses terminées, de la plus récente à la plus
 * ancienne, page par page (`GET /drivers/me/rides`). Sur chacune, la note qu'il a donnée à son
 * client -- qu'il pose ou corrige d'un appui. Le droit de noter vient du serveur
 * (`clientRatingAllowed`, invariant 3) : une course annulée n'a pas d'étoiles.
 *
 * Une correction passe par la file hors connexion, comme à l'encaissement : affichée aussitôt,
 * rétablie seulement si le serveur la refuse.
 */
type Props = NativeStackScreenProps<DriverParamList, 'RideHistory'>;

export const DRIVER_STATUS_LABELS: Record<http.RideHistoryStatus, string> = {
  settled: 'Encaissée',
  completed: 'Terminée',
  cancelled: 'Annulée',
};

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'loaded' };

export function RideHistoryScreen(_props: Props) {
  const [rides, setRides] = useState<http.DriverRideHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fetchPage = useCallback(async (cursor: string | null) => {
    return (await apiClient.request('driverRideHistory', { query: cursor ? { cursor } : {} })) as http.DriverRideHistoryResponse;
  }, []);

  const loadFirst = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await fetchPage(null);
      setRides(page.rides);
      setNextCursor(page.nextCursor);
      setState({ status: 'loaded' });
    } catch {
      setState({ status: 'error' });
    }
  }, [fetchPage]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      setRides((current) => [...current, ...page.rides]);
      setNextCursor(page.nextCursor);
    } catch {
      // La page suivante se redemande au prochain défilement : rien de perdu de ce qui est affiché.
    } finally {
      setLoadingMore(false);
    }
  }

  function setRating(rideId: string, rating: number | null) {
    setRides((current) => current.map((ride) => (ride.id === rideId ? { ...ride, clientRating: rating } : ride)));
  }

  async function rate(ride: http.DriverRideHistoryEntry, rating: number) {
    const previous = ride.clientRating;
    setRating(ride.id, rating);
    setErrors(({ [ride.id]: _dropped, ...rest }) => rest);
    try {
      await offlineRunner.attempt('rateClient', { pathParams: { id: ride.id }, body: { rating } });
    } catch (cause) {
      // Une erreur réseau ne rejette jamais (mise en file) : seul un refus du serveur arrive ici.
      setRating(ride.id, previous);
      setErrors((current) => ({
        ...current,
        [ride.id]: cause instanceof ApiError ? translateApiError(cause) : 'La note n’a pas pu être enregistrée.',
      }));
    }
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.centered} testID="driver-history-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.centered} testID="driver-history-error">
        <Text style={styles.muted}>Impossible de charger vos courses pour le moment.</Text>
        <Pressable testID="driver-history-retry" accessibilityRole="button" onPress={loadFirst} style={styles.retryButton}>
          <Text style={styles.retryLabel}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      testID="driver-history-list"
      style={styles.container}
      contentContainerStyle={rides.length === 0 ? styles.centered : styles.content}
      data={rides}
      keyExtractor={(ride) => ride.id}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={<Text style={styles.muted}>Aucune course pour le moment.</Text>}
      ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} /> : null}
      renderItem={({ item }) => (
        <View testID={`history-row-${item.id}`} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.date}>{formatRideDate(item.requestedAt)}</Text>
            <Text style={[styles.status, item.status === 'cancelled' ? styles.statusCancelled : null]}>
              {DRIVER_STATUS_LABELS[item.status]}
            </Text>
          </View>
          <Text style={styles.route} numberOfLines={2}>
            {item.pickupLabel ?? 'Départ'} → {item.dropoffLabel ?? 'Arrivée'}
          </Text>
          <Text style={styles.amount}>{item.status === 'cancelled' ? '—' : formatMoney(item.amount)}</Text>
          {item.clientRatingAllowed ? (
            <View style={styles.rating}>
              <Text style={styles.ratingLabel}>{item.clientRating === null ? 'Notez votre client' : 'Votre note du client'}</Text>
              <StarRating
                value={item.clientRating}
                onChange={(value) => rate(item, value)}
                size={28}
                testIDPrefix={`history-${item.id}`}
              />
              {errors[item.id] ? (
                <Text testID={`history-${item.id}-error`} style={styles.error}>
                  {errors[item.id]}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 16, gap: 12 },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  row: {
    gap: 6,
    padding: 14,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  date: { color: colors.muted, fontSize: 13 },
  status: { color: colors.brandText, fontWeight: '600', fontSize: 13 },
  statusCancelled: { color: colors.muted },
  route: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  amount: { color: colors.ink, fontWeight: '700' },
  rating: { gap: 2, paddingTop: 6, borderTopWidth: 1, borderColor: colors.border, marginTop: 4 },
  ratingLabel: { color: colors.muted, fontSize: 13 },
  error: { color: colors.dangerText },
  muted: { color: colors.muted, textAlign: 'center' },
  footer: { paddingVertical: 16 },
  retryButton: { ...buttons.base, ...buttons.md, ...buttons.secondary },
  retryLabel: { ...buttonLabels.base, ...buttonLabels.secondary },
});
