import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Cinq étoiles : affichage seul, ou saisie quand `onChange` est fourni. Chaque étoile fait 44 dp
 * de côté au moins (D20 -- gants, moto). Les étoiles portent `${testIDPrefix}-star-N` (le bouton)
 * et `${testIDPrefix}-star-N-glyph` (le caractère).
 */
export interface StarRatingProps {
  value: number | null;
  onChange?: (value: number) => void;
  disabled?: boolean;
  size?: number;
  testIDPrefix?: string;
}

const VALUES = [1, 2, 3, 4, 5] as const;

export const STAR_FILLED = '#F59E0B';
export const STAR_EMPTY = '#D1D5DB';

export function StarRating({ value, onChange, disabled = false, size = 32, testIDPrefix }: StarRatingProps) {
  return (
    <View style={styles.row}>
      {VALUES.map((star) => {
        const glyph = (
          <Text
            testID={testIDPrefix ? `${testIDPrefix}-star-${star}-glyph` : undefined}
            style={{ fontSize: size, color: value !== null && star <= value ? STAR_FILLED : STAR_EMPTY }}
          >
            ★
          </Text>
        );
        if (!onChange) return <View key={star}>{glyph}</View>;
        return (
          <Pressable
            key={star}
            testID={testIDPrefix ? `${testIDPrefix}-star-${star}` : undefined}
            accessibilityRole="button"
            accessibilityLabel={`${star} sur 5`}
            accessibilityState={{ selected: value === star, disabled }}
            disabled={disabled}
            hitSlop={4}
            onPress={() => onChange(star)}
            style={({ pressed }) => [styles.target, pressed ? styles.pressed : null]}
          >
            {glyph}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * La note reçue, en une ligne : « ★ 4,7 · 12 avis », « Nouveau · 2 avis » sous le seuil (la
 * moyenne arrive `null` du serveur, L4-09), « Pas encore d'avis » sans aucun avis.
 */
export function formatRatingSummary(summary: { average: number | null; count: number }): string {
  if (summary.count === 0) return 'Pas encore d’avis';
  const reviews = `${summary.count} avis`;
  if (summary.average === null) return `Nouveau · ${reviews}`;
  return `★ ${summary.average.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · ${reviews}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  target: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
