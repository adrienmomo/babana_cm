import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { ApiError, translateApiError } from '@babana/api-client';
import { apiClient } from '../auth';

/**
 * Partage de trajet (L8-03). Déclenché depuis l'écran de suivi (spécification). `Share.share`
 * (React Native) ouvre le sélecteur natif -- WhatsApp compris, "ce que les gens utilisent ici".
 * `react-native-web` n'implémente pas `Share` : un échec y affiche le lien en clair pour copie
 * manuelle plutôt que de faire échouer silencieusement (l'export web reste un complément de
 * démonstration, D22 -- mais le lien doit rester utilisable dessus).
 */

type Status = 'idle' | 'creating' | 'active' | 'revoking' | 'error';

export interface ShareTripButtonProps {
  rideId: string;
}

export function ShareTripButton({ rideId }: ShareTripButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const startShare = async () => {
    setStatus('creating');
    setErrorMessage(null);
    try {
      const response = (await apiClient.request('createRideShare', { pathParams: { id: rideId } })) as { url: string };
      setUrl(response.url);
      setStatus('active');
      try {
        await Share.share({ message: response.url });
      } catch {
        // Sélecteur natif indisponible (export web) ou fermé par l'utilisateur -- le lien reste
        // affiché ci-dessous pour copie manuelle, ce n'est pas un échec du partage lui-même.
      }
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof ApiError ? translateApiError(error) : 'Le partage a échoué. Réessayez.');
    }
  };

  const stopShare = async () => {
    setStatus('revoking');
    try {
      await apiClient.request('revokeRideShare', { pathParams: { id: rideId } });
      setUrl(null);
      setStatus('idle');
    } catch (error) {
      setStatus('active');
      setErrorMessage(error instanceof ApiError ? translateApiError(error) : 'La révocation a échoué. Réessayez.');
    }
  };

  return (
    <View style={styles.container}>
      {(status === 'active' || status === 'revoking') && url ? (
        <>
          <Text style={styles.link} selectable testID="share-link">
            {url}
          </Text>
          <Pressable
            testID="share-stop-button"
            accessibilityRole="button"
            disabled={status === 'revoking'}
            onPress={stopShare}
            style={styles.stopButton}
          >
            <Text style={styles.stopLabel}>{status === 'revoking' ? 'Arrêt…' : 'Arrêter le partage'}</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          testID="share-trip-button"
          accessibilityRole="button"
          disabled={status === 'creating'}
          onPress={startShare}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>{status === 'creating' ? 'Préparation…' : 'Partager le trajet'}</Text>
        </Pressable>
      )}
      {errorMessage ? (
        <Text style={styles.error} testID="share-error">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 4,
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  link: {
    fontSize: 11,
    color: '#2563EB',
    maxWidth: 200,
    textAlign: 'center',
  },
  stopButton: {
    paddingVertical: 4,
  },
  stopLabel: {
    color: '#DC2626',
    fontSize: 11,
    fontWeight: '600',
  },
  error: {
    color: '#DC2626',
    fontSize: 11,
    maxWidth: 160,
    textAlign: 'center',
  },
});
