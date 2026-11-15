import React from 'react';
import { StatusBar } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
import { useTheme, type ThemeMode, type ThemeStorage } from '@babana/ui';

/**
 * Apparence choisie (15 novembre) : gardée sur ce téléphone, jamais sur le serveur. La navigation
 * (en-têtes, fond des écrans) et la barre d'état suivent le thème.
 */
const THEME_MODE_KEY = 'babana.client.themeMode';

export const themeStorage: ThemeStorage = {
  get: () => AsyncStorage.getItem(THEME_MODE_KEY),
  set: (mode: ThemeMode) => AsyncStorage.setItem(THEME_MODE_KEY, mode),
};

export function useNavigationTheme(): Theme {
  const { colors } = useTheme();
  const base = colors.isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.brand,
      background: colors.canvas,
      card: colors.surface,
      text: colors.ink,
      border: colors.border,
      notification: colors.danger,
    },
  };
}

export function ThemedStatusBar() {
  const { colors } = useTheme();
  return <StatusBar barStyle={colors.isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.canvas} />;
}
