import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { asRideId } from '@babana/navigation';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatMoney, formatRideDate } from '../format';
import type { ClientParamList } from '../navigation/types';

/**
 * « Mes courses » (L6-10, version minimale de démonstration). Les courses terminées, de la plus
 * récente à la plus ancienne, chargées page par page (la taille est fixée par le serveur) : jamais
 * tout l'historique au premier affichage. Une course payée ouvre sa facture.
 */

type Props = NativeStackScreenProps<ClientParamList, 'History'>;

export const STATUS_LABELS: Record<http.RideHistoryStatus, string> = {
  settled: 'Payée',
  completed: 'Terminée',
  cancelled: 'Annulée',
};

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded' };

export function HistoryScreen({ navigation }: Props) {
  const [rides, setRides] = useState<http.RideHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (cursor: string | null) => {
    return (await apiClient.request('rideHistory', { query: cursor ? { cursor } : {} })) as http.RideHistoryResponse;
  }, []);

  const loadFirst = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await fetchPage(null);
      setRides(page.rides);
      setNextCursor(page.nextCursor);
      setState({ status: 'loaded' });
    } catch (cause) {
      setState({
        status: 'error',
        message: cause instanceof ApiError ? translateApiError(cause) : 'Impossible de charger vos courses. Réessayez.',
      });
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

  if (state.status === 'loading') {
    return (
      <View style={styles.centered} testID="history-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.centered} testID="history-error">
        <Text style={styles.error}>{state.message}</Text>
        <Button label="Réessayer" variant="secondary" onPress={loadFirst} testID="history-retry" />
      </View>
    );
  }

  return (
    <FlatList
      testID="history-list"
      style={styles.container}
      contentContainerStyle={rides.length === 0 ? styles.centered : styles.content}
      data={rides}
      keyExtractor={(ride) => ride.id}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        <Text style={styles.empty} testID="history-empty">
          Aucune course pour le moment.
        </Text>
      }
      ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} /> : null}
      renderItem={({ item }) => (
        <Pressable
          testID={`history-row-${item.id}`}
          disabled={!item.invoiceAvailable}
          onPress={() => navigation.navigate('Invoice', { rideId: asRideId(item.id) })}
          style={styles.row}
        >
          <View style={styles.rowHeader}>
            <Text style={styles.date}>{formatRideDate(item.requestedAt)}</Text>
            <Text style={[styles.status, item.status === 'cancelled' && styles.statusCancelled]}>
              {STATUS_LABELS[item.status]}
            </Text>
          </View>
          <Text style={styles.route} numberOfLines={2}>
            {item.pickupLabel ?? 'Départ'} → {item.dropoffLabel ?? 'Arrivée'}
          </Text>
          <View style={styles.rowFooter}>
            <Text style={styles.amount}>{item.status === 'cancelled' ? '—' : formatMoney(item.amount)}</Text>
            {item.invoiceAvailable ? <Text style={styles.invoiceLink}>Voir la facture ›</Text> : null}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12 },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  row: {
    gap: 6,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  date: { color: '#6B7280', fontSize: 13 },
  status: { color: '#137347', fontWeight: '600', fontSize: 13 },
  statusCancelled: { color: '#6B7280' },
  route: { color: '#1F2937', fontSize: 15, fontWeight: '600' },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { color: '#1F2937', fontWeight: '700' },
  invoiceLink: { color: '#137347', fontWeight: '600' },
  empty: { color: '#6B7280' },
  error: { color: '#B91C1C', textAlign: 'center' },
  footer: { marginVertical: 12 },
});
