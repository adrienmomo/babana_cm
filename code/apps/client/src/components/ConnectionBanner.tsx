import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { ConnectionState } from '@babana/api-client';
import { onRealtimeConnectionStateChange, realtimeClient } from '../realtime';
import { makeStyles } from '@babana/ui';

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
  const styles = useStyles();
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

const useStyles = makeStyles((c) => ({
  container: {
    width: '100%',
  },
  banner: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  connecting: {
    backgroundColor: c.warningSoft,
  },
  offline: {
    backgroundColor: c.dangerSoft,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    color: c.ink,
  },
  // fontSize 1, pas 0 : Android (RN 0.86) lève « FontSize should be a positive value » sur une
  // taille nulle, et plante l'app dès que la connexion réussit. La hauteur nulle masque déjà.
  hidden: {
    color: c.ink,
    height: 0,
    fontSize: 1,
  },
}));
