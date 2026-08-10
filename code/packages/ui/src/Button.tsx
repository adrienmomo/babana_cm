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
}

export function Button({ label, onPress, disabled = false, variant = 'primary' }: ButtonProps) {
  return (
    <Pressable
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
  base: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: '#0A7D3D',
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#0A7D3D',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.8,
  },
  label: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  labelSecondary: {
    color: '#0A7D3D',
  },
});
