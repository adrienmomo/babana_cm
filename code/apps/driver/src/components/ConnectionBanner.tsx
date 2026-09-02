import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConnectionState } from '@babana/api-client';
import { onRealtimeConnectionStateChange, realtimeClient } from '../realtime';

/**
 * Indicateur de connexion permanent (L6-16, critère 1) : trois états distincts, jamais deux --
 * `ConnectionState` (`@babana/api-client`, `realtime/handlers.ts`) porte déjà exactement cette
 * distinction, posée en L6-04 en prévision de cet écran (voir son commentaire de tête). Aucun
 * second mécanisme de détection réseau : la connexion WebSocket est le seul signal de
 * connectivité que l'app connaisse aujourd'hui.
 *
 * `connecting` se lit « dégradé » (spécification) : une reconnexion est en cours, toute écriture
 * tentée pendant ce temps est mise en file (`../offline.ts`, `@babana/api-client/offline`) --
 * jamais perdue, jamais doublée à son arrivée, mais pas encore confirmée non plus.
 */
const LABELS: Record<ConnectionState, string> = {
  connected: 'Connecté',
  connecting: 'Connexion dégradée — vos actions sont mises en attente',
  offline: 'Hors ligne — vos actions seront envoyées au retour du réseau',
};

export function ConnectionBanner() {
  const [state, setState] = useState<ConnectionState>(() => realtimeClient.getState());

  useEffect(() => onRealtimeConnectionStateChange(setState), []);

  // Rien à annoncer en fonctionnement normal (critère 1 : l'indicateur reste présent, mais un
  // bandeau vert permanent en haut de chaque écran serait plus gênant qu'utile) -- un espace
  // réservé de hauteur nulle plutôt qu'un démontage : la mise en page ne saute jamais au moment
  // où l'état change.
  return (
    <View testID="connection-banner" style={styles.container}>
      {state !== 'connected' ? (
        <View style={[styles.banner, state === 'offline' ? styles.offline : styles.connecting]}>
          <Text style={styles.text} testID="connection-banner-label">
            {LABELS[state]}
          </Text>
        </View>
      ) : (
        // Toujours présent dans l'arbre (accessibilité : un lecteur d'écran qui interroge cette
        // zone trouve un état, jamais une absence) -- juste sans hauteur ni couleur.
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
