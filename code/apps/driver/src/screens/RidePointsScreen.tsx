import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatRideDate } from '../format';
import { makeStyles } from '../theme';

/**
 * « Courses acceptées » (19 novembre), ouvert depuis « Ma priorité » : le journal des points de
 * course -- un −1 rouge par proposition laissée sans réponse, un +1 vert par course terminée, avec
 * le solde après chaque ligne. Tel que le serveur l'a écrit (`GET /drivers/me/priority/ride-points`),
 * par pages, comme « Mes courses ».
 */
type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'loaded' };

const KIND_LABELS: Record<http.RidePointsLogEntry['kind'], string> = {
  missed: 'Proposition sans réponse',
  completed: 'Course terminée',
};

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function RidePointsScreen() {
  const styles = useStyles();
  const [entries, setEntries] = useState<http.RidePointsLogEntry[]>([]);
  const [summary, setSummary] = useState<{ points: number; max: number } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (cursor: string | null) => {
    return (await apiClient.request('driverRidePointsLog', { query: cursor ? { cursor } : {} })) as http.RidePointsLogResponse;
  }, []);

  const loadFirst = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await fetchPage(null);
      setEntries(page.entries);
      setSummary({ points: page.ridePoints, max: page.ridePointsMax });
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
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch {
      // Redemandée au prochain défilement : rien de perdu de ce qui est affiché.
    } finally {
      setLoadingMore(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.centered} testID="ride-points-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.centered} testID="ride-points-error">
        <Text style={styles.muted}>Impossible de charger l'historique de vos points pour le moment.</Text>
        <Pressable testID="ride-points-retry" accessibilityRole="button" onPress={loadFirst} style={styles.retryButton}>
          <Text style={styles.retryLabel}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      testID="ride-points-list"
      style={styles.container}
      contentContainerStyle={styles.content}
      data={entries}
      keyExtractor={(entry) => entry.id}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        summary ? (
          <View style={styles.header}>
            <Text style={styles.headerValue} testID="ride-points-summary">
              {summary.points}
              <Text style={styles.headerMax}> / {summary.max}</Text>
            </Text>
            <Text style={styles.muted}>
              Une proposition laissée sans réponse fait perdre des points. Chaque course terminée en rend, jusqu'au maximum.
            </Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <Text style={[styles.muted, styles.empty]} testID="ride-points-empty">
          Aucun mouvement pour l'instant.
        </Text>
      }
      ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} /> : null}
      renderItem={({ item }) => {
        const gain = item.delta > 0;
        const route = [item.pickupLabel, item.dropoffLabel].filter(Boolean).join(' → ');
        return (
          <View style={styles.row} testID={`ride-points-entry-${item.id}`}>
            <View style={[styles.badge, gain ? styles.badgeGain : styles.badgeLoss]}>
              <Text style={[styles.delta, gain ? styles.gain : styles.loss]} testID={`ride-points-delta-${item.id}`}>
                {signed(item.delta)}
              </Text>
            </View>
            <View style={styles.body}>
              <Text style={styles.kind}>{KIND_LABELS[item.kind]}</Text>
              <Text style={styles.meta}>
                {formatRideDate(item.occurredAt)}
                {item.rideReference ? ` · ${item.rideReference}` : ''}
              </Text>
              {route ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {route}
                </Text>
              ) : null}
            </View>
            <Text style={styles.balance}>{item.balanceAfter}</Text>
          </View>
        );
      }}
    />
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.canvas },
  content: { paddingBottom: 32 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: c.canvas },
  header: { gap: 6, padding: 20, backgroundColor: c.surface, borderBottomWidth: 1, borderColor: c.border },
  headerValue: { color: c.ink, fontSize: 32, fontWeight: '800' },
  headerMax: { color: c.muted, fontSize: 18, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  badge: { width: 52, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  badgeGain: { backgroundColor: c.brandSoft, borderColor: c.brandBorder },
  badgeLoss: { backgroundColor: c.dangerSoft, borderColor: c.dangerBorder },
  delta: { fontSize: 18, fontWeight: '800' },
  gain: { color: c.brandText },
  loss: { color: c.dangerText },
  body: { flex: 1, gap: 2 },
  kind: { color: c.ink, fontSize: 16, fontWeight: '600' },
  meta: { color: c.muted, fontSize: 13 },
  balance: { color: c.inkSoft, fontSize: 15, fontWeight: '600' },
  muted: { color: c.muted, fontSize: 14, lineHeight: 20 },
  empty: { padding: 24, textAlign: 'center' },
  footer: { paddingVertical: 16 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: c.brandBorder },
  retryLabel: { color: c.brandText, fontWeight: '600' },
}));
