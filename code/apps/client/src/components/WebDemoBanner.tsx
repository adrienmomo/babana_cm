import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

/**
 * Dégradations signalées, jamais masquées (L6-18, spécification -- "un bandeau discret précisant
 * que la version web est une démonstration"). Quatre limites du bundle web, aucune contournée
 * silencieusement :
 *
 * - **Notifications push** : aucun jeton FCM n'est enregistré depuis un navigateur (L7-01 vise
 *   les apps natives).
 * - **Capture de position en arrière-plan** : `location.web.ts` (L6-06) n'obtient une position
 *   qu'au premier plan, sur demande explicite -- un onglet en arrière-plan n'émet rien.
 * - **Lien profond de navigation** : `providers/web/navigation.ts` (L6-18) ouvre un nouvel
 *   onglet Google Maps mais ne peut jamais détecter un retour (`onComplete` n'est pas rappelé,
 *   contrairement au lien profond natif qui observe `AppState`).
 * - **Session non persistée (D39)** : `tokenStorage.web.ts` (L6-18) garde la session en mémoire
 *   seulement -- fermer l'onglet déconnecte, rouvrir demande une reconnexion.
 *
 * Un seul `Platform.OS === 'web'`, dans ce fichier -- jamais dans un écran (critère d'acceptation
 * 3, L6-18) : `apps/client/src/screens/**` n'a besoin de rien savoir de cette bannière ni de la
 * plateforme qui la justifie.
 */
export function WebDemoBanner() {
  if (Platform.OS !== 'web') return null;

  return (
    <View testID="web-demo-banner" style={styles.container}>
      <Text style={styles.text} testID="web-demo-banner-label">
        Version de démonstration web — notifications, suivi en arrière-plan et navigation externe
        limités ; fermer cet onglet déconnecte.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#EFF6FF',
    borderBottomWidth: 1,
    borderBottomColor: '#BFDBFE',
  },
  text: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    fontSize: 12,
    textAlign: 'center',
    color: '#1E3A8A',
  },
});
