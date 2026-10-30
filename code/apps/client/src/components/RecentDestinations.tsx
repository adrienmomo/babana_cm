import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { fetchRecentDestinations } from '../recentDestinations';
import type { RidePoint } from '../navigation/types';

/**
 * Raccourcis « destinations récentes » sous la recherche de l'accueil. Chargés une fois ; un échec
 * (hors connexion, serveur) n'affiche simplement rien -- la recherche et la carte restent là.
 */
export function RecentDestinations({ onSelect }: { onSelect: (point: RidePoint) => void }) {
  const [points, setPoints] = useState<RidePoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchRecentDestinations()
      .then((loaded) => {
        if (!cancelled) setPoints(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (points.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // Sans flexGrow: 0, une ScrollView horizontale s'étire en hauteur dans la colonne de l'accueil
      // et les raccourcis deviennent d'immenses ovales (vu sur l'émulateur le 30 octobre).
      style={styles.scroller}
      contentContainerStyle={styles.row}
      testID="recent-destinations"
    >
      {points.map((point, index) => (
        <Pressable
          key={point.label}
          testID={`recent-destination-${index}`}
          onPress={() => onSelect(point)}
          style={styles.chip}
          accessibilityLabel={`Aller ${point.label}`}
        >
          <Text style={styles.chipText} numberOfLines={1}>
            {/* « vers » marque une approximation au moment de la désignation ; ici c'est un lieu connu. */}
            {point.label.replace(/^vers\s+/i, '')}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, flexShrink: 0 },
  row: { gap: 8, alignItems: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#B8E2CB',
    backgroundColor: '#E8F6EE',
    maxWidth: 220,
    alignSelf: 'center',
  },
  chipText: { color: '#137347', fontWeight: '600' },
});
