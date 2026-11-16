/**
 * Babana -- application Client. Racine de l'app : la navigation (L6-00) est montée ici, dans
 * `SafeAreaProvider` pour que `react-native-safe-area-context` (dépendance de
 * `@react-navigation/native-stack`) fonctionne dès le premier écran.
 *
 * @format
 */

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@babana/ui';
import { ThemedStatusBar, themeStorage } from './src/appearance';
import { AppNavigator } from './src/navigation';

function App() {
  return (
    <ThemeProvider storage={themeStorage}>
      <SafeAreaProvider>
        <ThemedStatusBar />
        <AppNavigator />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

export default App;
