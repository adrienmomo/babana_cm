import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { makeStyles } from '../theme';

/**
 * « Note des clients » (19 novembre), ouvert depuis « Ma priorité » : comment les points de note se
 * calculent -- nombre et moyenne des avis, notes de départ, moyenne retenue, paliers -- sans la
 * liste des avis. Tout vient de `GET /drivers/me/priority/stars` : les seuils affichés sont ceux du
 * serveur, l'app ne décide pas quel palier est atteint (invariant 3).
 */
type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; detail: http.StarPointsResponse };

function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

export function StarPointsScreen() {
  const styles = useStyles();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const detail = (await apiClient.request('driverStarPoints')) as http.StarPointsResponse;
      setState({ status: 'loaded', detail });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <View style={styles.centered} testID="star-points-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={styles.centered} testID="star-points-error">
        <Text style={styles.muted}>Impossible de charger le détail de votre note pour le moment.</Text>
        <Pressable testID="star-points-retry" accessibilityRole="button" onPress={load} style={styles.retryButton}>
          <Text style={styles.retryLabel}>Réessayer</Text>
        </Pressable>
      </View>
    );
  }

  const { detail } = state;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="star-points-screen">
      <View style={styles.card}>
        <Text style={styles.caption}>Points de note</Text>
        <Text style={styles.total} testID="star-points-total">
          {detail.starPoints}
          <Text style={styles.totalMax}> / {detail.starPointsMax}</Text>
        </Text>
        <Text style={styles.muted}>Vos points dépendent de la moyenne retenue ci-dessous.</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.line}>
          <Text style={styles.label}>Avis de vos clients</Text>
          <Text style={styles.value} testID="star-points-count">
            {detail.ratingCount}
          </Text>
        </View>
        <View style={styles.line}>
          <Text style={styles.label}>Moyenne de ces avis</Text>
          <Text style={styles.value} testID="star-points-raw-average">
            {detail.ratingAverage === null ? '—' : `★ ${decimal(detail.ratingAverage, 1)}`}
          </Text>
        </View>
        <View style={styles.line}>
          <Text style={styles.label}>Notes de départ</Text>
          <Text style={styles.value}>{`${detail.priorCount} × ★ ${decimal(detail.priorValue, 0)}`}</Text>
        </View>
        <View style={[styles.line, styles.lineStrong]}>
          <Text style={styles.labelStrong}>Moyenne retenue</Text>
          <Text style={styles.valueStrong} testID="star-points-average">{`★ ${decimal(detail.smoothedAverage, 2)}`}</Text>
        </View>
        <Text style={styles.muted}>
          Chaque chauffeur commence avec {detail.priorCount} notes de {decimal(detail.priorValue, 0)} étoiles : quelques avis ne suffisent pas à
          faire chuter vos points.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.caption}>Paliers</Text>
        {detail.tiers.map((tier) => (
          <View key={tier.above} style={[styles.tier, tier.applied ? styles.tierApplied : null]} testID={`star-points-tier-${tier.above}`}>
            <Text style={[styles.tierMark, tier.applied ? styles.tierMarkApplied : null]}>{tier.applied ? '✓' : '○'}</Text>
            <View style={styles.tierBody}>
              <Text style={styles.tierLabel}>{`Au-dessus de ★ ${decimal(tier.above, 1)}`}</Text>
              {tier.applied ? <Text style={styles.tierAppliedLabel}>Votre palier</Text> : null}
            </View>
            <Text style={styles.tierPoints}>{`+${tier.points}`}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.canvas },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: c.canvas },
  card: { backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 16, gap: 10 },
  caption: { color: c.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  total: { color: c.ink, fontSize: 40, fontWeight: '800' },
  totalMax: { color: c.muted, fontSize: 18, fontWeight: '600' },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  lineStrong: { borderTopWidth: 1, borderColor: c.border, paddingTop: 10 },
  label: { color: c.inkSoft, fontSize: 15, flexShrink: 1 },
  value: { color: c.ink, fontSize: 15, fontWeight: '600' },
  labelStrong: { color: c.ink, fontSize: 16, fontWeight: '700' },
  valueStrong: { color: c.ink, fontSize: 18, fontWeight: '800' },
  tier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceMuted,
  },
  tierApplied: { backgroundColor: c.brandSoft, borderColor: c.brandBorder },
  tierMark: { color: c.muted, fontSize: 18, fontWeight: '800', width: 20, textAlign: 'center' },
  tierMarkApplied: { color: c.brandText },
  tierBody: { flex: 1, gap: 2 },
  tierLabel: { color: c.ink, fontSize: 15, fontWeight: '600' },
  tierAppliedLabel: { color: c.brandText, fontSize: 13, fontWeight: '600' },
  tierPoints: { color: c.ink, fontSize: 16, fontWeight: '700' },
  muted: { color: c.muted, fontSize: 14, lineHeight: 20 },
  retryButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: c.brandBorder },
  retryLabel: { color: c.brandText, fontWeight: '600' },
}));
