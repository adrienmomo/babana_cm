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
 * Connexion Google (L6-02) -- même écran que `apps/client`, seul le rôle échangé diffère
 * ('driver' plutôt que 'client', voir `handlePress`). Un chauffeur non approuvé se connecte
 * normalement : `session.user.driverStatus` porte 'pending', et c'est à l'appelant de router
 * vers le parcours d'inscription / suivi de dossier (L6-15) plutôt que vers l'accueil --
 * critère d'acceptation 5, la donnée existe déjà dans la session, ce n'est jamais une erreur de
 * connexion.
 */
export interface SignInScreenProps {
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
      const session = await authClient.exchangeGoogleIdToken(idToken, 'driver');
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
      <Text style={styles.title}>Babana -- Chauffeur</Text>
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
