import React from 'react';
import { Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { makeStyles, useColors } from '../theme';

/**
 * Barre de priorité (19 novembre) : une piste par sorte de points -- courses, note, nouveau
 * chauffeur -- chacune aussi large que son maximum, remplie de ce que le serveur a compté. Rien
 * n'est calculé ici hors de la mise à l'échelle (invariant 3).
 *
 * La piste « nouveau chauffeur » est **verrouillée** quand elle ne rapporte plus rien : la
 * période est passée, ces points ne reviendront pas -- ils restent visibles, grisés et cadenassés,
 * pour que le chauffeur comprenne pourquoi il ne peut plus atteindre le maximum.
 */
export function newDriverPointsLocked(priority: http.DriverPriority): boolean {
  return priority.newDriverPointsMax > 0 && priority.newDriverPoints === 0;
}

type Segment = { key: string; label: string; points: number; max: number; color: string; locked?: boolean };

export function prioritySegments(priority: http.DriverPriority, colors: ReturnType<typeof useColors>): Segment[] {
  return [
    { key: 'rides', label: 'Courses', points: priority.ridePoints, max: priority.ridePointsMax, color: colors.brand },
    { key: 'stars', label: 'Note', points: priority.starPoints, max: priority.starPointsMax, color: colors.warning },
    {
      key: 'new',
      label: 'Nouveau',
      points: priority.newDriverPoints,
      max: priority.newDriverPointsMax,
      color: colors.info,
      locked: newDriverPointsLocked(priority),
    },
  ].filter((segment) => segment.max > 0);
}

export function PriorityBar({ priority, showLegend = true }: { priority: http.DriverPriority; showLegend?: boolean }) {
  const styles = useStyles();
  const colors = useColors();
  const segments = prioritySegments(priority, colors);

  return (
    <View
      testID="priority-bar"
      accessibilityRole="progressbar"
      accessibilityLabel={`Priorité : ${priority.total} sur ${priority.max} points`}
      accessibilityValue={{ min: 0, max: priority.max, now: priority.total }}
    >
      <View style={styles.track}>
        {segments.map((segment) => (
          <View
            key={segment.key}
            testID={`priority-bar-${segment.key}${segment.locked ? '-locked' : ''}`}
            style={[styles.section, { flexGrow: segment.max }, segment.locked ? styles.locked : null]}
          >
            {segment.locked ? (
              <Text style={styles.lock}>🔒</Text>
            ) : (
              <View
                style={[
                  styles.fill,
                  { width: `${Math.min(100, (segment.points / segment.max) * 100)}%`, backgroundColor: segment.color },
                ]}
              />
            )}
          </View>
        ))}
      </View>
      {showLegend ? (
        <View style={styles.legend}>
          {segments.map((segment) => (
            <View key={segment.key} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: segment.locked ? colors.subtle : segment.color }]} />
              <Text style={[styles.legendText, segment.locked ? styles.legendLocked : null]}>
                {segment.locked ? `${segment.label} · verrouillé` : `${segment.label} ${segment.points}/${segment.max}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  track: {
    flexDirection: 'row',
    height: 18,
    gap: 3,
  },
  section: {
    flexBasis: 0,
    minWidth: 22,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
  },
  fill: {
    height: '100%',
    borderRadius: 9,
  },
  locked: {
    alignItems: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.borderStrong,
  },
  lock: { fontSize: 10, color: c.muted },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: c.inkSoft, fontSize: 13 },
  legendLocked: { color: c.muted },
}));
