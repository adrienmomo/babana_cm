/**
 * Babana -- application Chauffeur. Squelette L0-03 : vérifie que @babana/ui, @babana/contracts,
 * @babana/maps et @babana/api-client sont importables depuis cette app (critère d'acceptation 3
 * de L0-03). Aucun écran métier ce soir, hors du lot autorisé.
 *
 * @format
 */

import React, { useState } from 'react';
import { StatusBar, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@babana/ui';
import { API_BASE_URL } from './config';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [count, setCount] = useState(0);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <View style={styles.content}>
          <Text style={styles.title}>Babana -- Chauffeur</Text>
          <Text style={styles.subtitle}>Squelette du monorepo (L0-03)</Text>
          <Text style={styles.subtitle}>{API_BASE_URL}</Text>
          <Button label={`@babana/ui fonctionne (${count})`} onPress={() => setCount((c) => c + 1)} />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    color: '#666666',
  },
});

export default App;
