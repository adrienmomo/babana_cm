import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConnectionState } from '@babana/api-client';
import { onRealtimeConnectionStateChange, realtimeClient } from '../realtime';

/**
 * Indicateur de connexion permanent (L6-16, critère 1). Même composant que
 * `apps/driver/src/components/ConnectionBanner.tsx` -- voir ce fichier pour le raisonnement
 * complet -- dupliqué plutôt que partagé : deux apps, deux imports relatifs vers `../realtime`,
 * et rien d'autre à factoriser qu'une poignée de lignes déjà entièrement documentées ici.
 */
const LABELS: Record<ConnectionState, string> = {
  connected: 'Connecté',
  connecting: 'Connexion dégradée — vos actions sont mises en attente',
  offline: 'Hors ligne — vos actions seront envoyées au retour du réseau',
};

export function ConnectionBanner() {
  const [state, setState] = useState<ConnectionState>(() => realtimeClient.getState());

  useEffect(() => onRealtimeConnectionStateChange(setState), []);

  return (
    <View testID="connection-banner" style={styles.container}>
      {state !== 'connected' ? (
        <View style={[styles.banner, state === 'offline' ? styles.offline : styles.connecting]}>
          <Text style={styles.text} testID="connection-banner-label">
            {LABELS[state]}
          </Text>
        </View>
      ) : (
        <Text testID="connection-banner-label" style={styles.hidden} accessibilityElementsHidden>
          {LABELS.connected}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  banner: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  connecting: {
    backgroundColor: '#FEF3C7',
  },
  offline: {
    backgroundColor: '#FEE2E2',
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    color: '#111827',
  },
  hidden: {
    height: 0,
    fontSize: 0,
  },
});
