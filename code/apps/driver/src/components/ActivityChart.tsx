import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { colors, radius } from '../theme';
import { formatMoney } from '../format';

/**
 * Activité du chauffeur en barres (écran « Ma caisse ») : recette encaissée par jour, semaine ou
 * mois -- sept barres, la période en cours à droite. **« Recette encaissée », jamais « revenus »**
 * (É6, même règle que CashScreen).
 *
 * Les trois vues arrivent dans une seule réponse (`GET /drivers/me/activity`) : basculer ne coûte
 * aucun appel. Rien n'est calculé ici hors de la mise à l'échelle des barres (hauteur relative à la
 * plus haute) et des libellés de date -- les montants et les nombres de courses sont ceux d'Odoo.
 *
 * Barres en simples `View` : pas de bibliothèque de graphiques pour sept rectangles.
 */

export type ActivityView = 'day' | 'week' | 'month';

const VIEWS: ReadonlyArray<{ key: ActivityView; label: string }> = [
  { key: 'day', label: 'Jour' },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
];

const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_LONG = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const CHART_HEIGHT = 120;
// Une barre vide reste visible : « rien encaissé » se voit, au lieu d'un trou dans l'axe.
const EMPTY_BAR_HEIGHT = 2;

/** 'AAAA-MM-JJ' en date LOCALE -- `new Date('2026-10-26')` serait minuit UTC, la veille ailleurs. */
function localDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function barLabel(view: ActivityView, start: string, isCurrent: boolean): string {
  const date = localDate(start);
  if (view === 'day') return isCurrent ? 'Auj.' : WEEKDAYS[date.getDay()] ?? '';
  if (view === 'week') return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}`;
  return MONTHS[date.getMonth()] ?? '';
}

export function periodTitle(view: ActivityView, start: string, isCurrent: boolean): string {
  const date = localDate(start);
  if (view === 'day') {
    if (isCurrent) return 'Aujourd’hui';
    return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS_LONG[date.getMonth()]}`;
  }
  if (view === 'week') {
    return isCurrent ? 'Cette semaine' : `Semaine du ${date.getDate()} ${MONTHS_LONG[date.getMonth()]}`;
  }
  return isCurrent ? 'Ce mois-ci' : `${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
}

function ridesLabel(rides: number): string {
  return `${rides} course${rides > 1 ? 's' : ''}`;
}

export function ActivityChart({ activity }: { activity: http.DriverActivityResponse }) {
  const [view, setView] = useState<ActivityView>('day');
  const buckets = activity[view];
  const [selected, setSelected] = useState(buckets.length - 1);

  // Changer de vue ramène à la période en cours, la plus utile.
  useEffect(() => {
    setSelected(activity[view].length - 1);
  }, [view, activity]);

  const highest = Math.max(0, ...buckets.map((bucket) => bucket.collected));
  const current = buckets[selected];

  return (
    <View style={styles.card} testID="activity-chart">
      <Text style={styles.title}>Activité</Text>

      <View style={styles.switcher} accessibilityRole="tablist">
        {VIEWS.map(({ key, label }) => (
          <Pressable
            key={key}
            testID={`activity-view-${key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: key === view }}
            onPress={() => setView(key)}
            style={[styles.switch, key === view && styles.switchActive]}
          >
            <Text style={[styles.switchText, key === view && styles.switchTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {current ? (
        <View style={styles.summary} testID="activity-summary">
          <Text style={styles.summaryPeriod}>{periodTitle(view, current.start, selected === buckets.length - 1)}</Text>
          <Text style={styles.summaryAmount} testID="activity-selected-amount">
            {formatMoney(current.collected)}
          </Text>
          <Text style={styles.summaryRides} testID="activity-selected-rides">
            Recette encaissée · {ridesLabel(current.rides)}
          </Text>
        </View>
      ) : null}

      <View style={styles.chart}>
        {buckets.map((bucket, index) => {
          const isCurrent = index === buckets.length - 1;
          const height =
            highest > 0 && bucket.collected > 0
              ? Math.max(EMPTY_BAR_HEIGHT, Math.round((bucket.collected / highest) * CHART_HEIGHT))
              : EMPTY_BAR_HEIGHT;
          return (
            <Pressable
              key={bucket.start}
              testID={`activity-bar-${index}`}
              accessibilityLabel={`${periodTitle(view, bucket.start, isCurrent)} : ${formatMoney(bucket.collected)}, ${ridesLabel(bucket.rides)}`}
              onPress={() => setSelected(index)}
              style={styles.column}
            >
              <View style={styles.barTrack}>
                <View
                  testID={`activity-bar-fill-${index}`}
                  style={[
                    styles.bar,
                    { height },
                    index === selected ? styles.barSelected : null,
                  ]}
                />
              </View>
              <Text style={[styles.barLabel, index === selected && styles.barLabelSelected]} numberOfLines={1}>
                {barLabel(view, bucket.start, isCurrent)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: 16,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
  },
  switcher: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
  },
  switch: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  switchActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brandBorder,
  },
  switchText: {
    color: colors.muted,
    fontWeight: '600',
  },
  switchTextActive: {
    color: colors.brandText,
  },
  summary: {
    gap: 2,
  },
  summaryPeriod: {
    color: colors.muted,
    fontSize: 13,
  },
  summaryAmount: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
  },
  summaryRides: {
    color: colors.muted,
    fontSize: 12,
  },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  column: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  barTrack: {
    height: CHART_HEIGHT,
    width: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    backgroundColor: colors.brandBorder,
  },
  barSelected: {
    backgroundColor: colors.brand,
  },
  barLabel: {
    fontSize: 11,
    color: colors.muted,
  },
  barLabelSelected: {
    color: colors.brandText,
    fontWeight: '700',
  },
});
