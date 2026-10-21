import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

/**
 * Uniquement des primitives `react-native` (Pressable, StyleSheet, Text) : compatibles
 * react-native-web sans adaptation (D22). Aucune bibliothèque UI tierce ajoutée -- pas de
 * dépendance nouvelle sans nécessité (CLAUDE.md).
 */
export interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  testID?: string;
}

export function Button({ label, onPress, disabled = false, variant = 'primary', testID }: ButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variant === 'secondary' ? styles.secondary : styles.primary,
        disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.label, variant === 'secondary' ? styles.labelSecondary : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Pilule douce, même forme et même palette que les boutons de l'app Chauffeur
  // (apps/driver/src/theme.ts) : 48 dp minimum (D20), bordure fine, vert adouci.
  base: {
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: '#1A9E5C',
    borderColor: '#1A9E5C',
  },
  secondary: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.8,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  labelSecondary: {
    color: '#1F2937',
  },
});
