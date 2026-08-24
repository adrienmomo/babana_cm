import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Compte à rebours visuel (L6-12) -- purement indicatif, comme le rappelle l'écran appelant : le
 * serveur seul est juge de l'expiration (spécification L3-07). Aucune bibliothèque de tracé
 * (aucune n'est présente dans le dépôt, D20 : générique au pilote, pas de dépendance nouvelle
 * sans nécessité) -- l'« anneau » est un simple cercle `View`, pas un arc proportionnel tracé.
 */
export interface CountdownRingProps {
  /** Jamais négatif à l'affichage -- un compte à rebours qui a dépassé zéro reste à zéro, la
   * décision d'expiration elle-même appartient au serveur. */
  remainingSeconds: number;
}

const URGENT_THRESHOLD_SECONDS = 10;

export function CountdownRing({ remainingSeconds }: CountdownRingProps) {
  const clamped = Math.max(0, remainingSeconds);
  const urgent = clamped <= URGENT_THRESHOLD_SECONDS;

  return (
    <View style={[styles.ring, urgent ? styles.ringUrgent : null]} testID="countdown-ring">
      <Text style={styles.value} testID="countdown-value">
        {clamped}
      </Text>
      <Text style={styles.unit}>s</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 6,
    borderColor: '#0A7D3D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringUrgent: {
    borderColor: '#DC2626',
  },
  value: {
    fontSize: 32,
    fontWeight: '700',
    color: '#111827',
  },
  unit: {
    fontSize: 12,
    color: '#6B7280',
  },
});
