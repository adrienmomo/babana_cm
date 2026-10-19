import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AuthState } from '@babana/api-client';

/**
 * Écran de connexion -- emplacement de la connexion par numéro de téléphone et code SMS (OTP),
 * qui remplace Google Sign-In. Volontairement vide d'action tant que les endpoints OTP n'existent
 * pas : aucune connexion n'est possible depuis l'app dans cet état, et c'est attendu.
 *
 * `onSignedIn` reste dans le contrat de l'écran : le routage qui suit la connexion (chauffeur) est
 * décidé par l'appelant à partir de `session.user`, pas par cet écran.
 */
export interface SignInScreenProps {
  onSignedIn: (session: AuthState) => void;
}

export function SignInScreen(_props: SignInScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Babana -- Chauffeur</Text>
      <Text style={styles.notice}>La connexion par numéro de téléphone arrive bientôt.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  notice: {
    textAlign: 'center',
  },
});
