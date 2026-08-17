import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@babana/ui';
import {
  GooglePlayServicesUnavailableError,
  GoogleSignInCancelledError,
  signInWithGoogleNative,
  type AuthState,
} from '@babana/api-client';
import { authClient } from '../auth';

/**
 * Connexion Google (L6-02). Toute la logique -- obtention de l'ID token, échange contre le jeton
 * applicatif, stockage sécurisé -- vit dans `@babana/api-client` et `../auth.ts` ; cet écran ne
 * fait que déclencher l'action et afficher son résultat (invariant 3, aucune règle métier dans
 * l'app).
 */
export interface SignInScreenProps {
  /** Le routage qui suit (accueil, ou suivi de dossier pour un chauffeur `pending`, L6-15) est
   * décidé par l'appelant à partir de `session.user` -- pas par cet écran. */
  onSignedIn: (session: AuthState) => void;
}

export function SignInScreen({ onSignedIn }: SignInScreenProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePress() {
    setError(null);
    setPending(true);
    try {
      const idToken = await signInWithGoogleNative();
      const session = await authClient.exchangeGoogleIdToken(idToken, 'client');
      onSignedIn(session);
    } catch (cause) {
      if (cause instanceof GoogleSignInCancelledError) {
        // Annulation volontaire par l'utilisateur -- rien à signaler.
      } else if (cause instanceof GooglePlayServicesUnavailableError) {
        setError(cause.message);
      } else {
        setError('La connexion a échoué. Réessayez.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Babana</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label={pending ? 'Connexion…' : 'Se connecter avec Google'} onPress={handlePress} disabled={pending} />
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
  error: {
    color: '#B91C1C',
    textAlign: 'center',
  },
});
