import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, translateApiError, flushPendingIncidentTriggers, type PendingIncidentTrigger } from '@babana/api-client';
import { apiClient } from '../auth';
import { getCurrentPosition } from '../location';
import { pendingIncidentQueue } from '../incidentQueue';

/**
 * Bouton d'urgence (L8-04). Atteignable en un geste depuis l'écran de suivi (critère 1) --
 * monté directement dans TrackingScreen, jamais enfoui dans un menu (spécification : « l'utilité
 * tient entièrement à l'accessibilité en situation de stress »).
 *
 * **Appui long, pas une boîte de dialogue** (spécification, confirmation en deux temps) :
 * `onLongPress` après `HOLD_MS` de pression continue -- un relâchement avant ce délai n'a aucun
 * effet, exactement le geste qui distingue une pression accidentelle en poche d'une décision.
 *
 * Hors connexion (critère 6) : la position et l'horodatage d'origine sont mis en file locale
 * (`../incidentQueue`) AVANT toute tentative réseau -- si l'appareil est tué juste après, le
 * déclenchement survit. La file est rejouée à chaque montage (reconnexion typique : l'écran de
 * suivi se remonte après un redémarrage d'app).
 */

type Status = 'idle' | 'holding' | 'sending' | 'sent' | 'queued' | 'error';

const HOLD_MS = 800;

export interface EmergencyButtonProps {
  rideId: string;
}

export function EmergencyButton({ rideId }: EmergencyButtonProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  type SubmitOutcome = 'ok' | 'network-failure' | 'business-error';

  const submitOnce = useCallback(async (trigger: PendingIncidentTrigger): Promise<SubmitOutcome> => {
    try {
      await apiClient.request('triggerIncident', {
        pathParams: { id: trigger.rideId },
        body: { latitude: trigger.latitude, longitude: trigger.longitude, triggeredAt: trigger.triggeredAt },
        idempotencyKey: trigger.idempotencyKey,
      });
      return 'ok';
    } catch (error) {
      if (error instanceof ApiError) {
        // Erreur métier (course non active, par exemple) -- rejouer ne réussira jamais, mais ce
        // n'est pas un échec réseau : on ne la laisse pas dans la file indéfiniment.
        await pendingIncidentQueue.remove(trigger.idempotencyKey);
        if (mountedRef.current) setErrorMessage(translateApiError(error));
        return 'business-error';
      }
      return 'network-failure';
    }
  }, []);

  // flushPendingIncidentTriggers n'a besoin que d'un booléen (succès/échec réseau) -- une
  // erreur métier compte comme "traitée" à ses yeux (retirée de la file par submitOnce
  // ci-dessus), donc comme un succès de traitement, jamais rejouée en boucle.
  const flushOne = useCallback(
    async (trigger: PendingIncidentTrigger) => (await submitOnce(trigger)) !== 'network-failure',
    [submitOnce]
  );

  // Rejeu de ce qui n'a pas pu partir avant (redémarrage d'app en pleine coupure réseau).
  useEffect(() => {
    mountedRef.current = true;
    flushPendingIncidentTriggers(pendingIncidentQueue, flushOne).catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, [flushOne]);

  const trigger = useCallback(async () => {
    setStatus('sending');
    setErrorMessage(null);

    const location = await getCurrentPosition();
    if (location.status !== 'success') {
      if (mountedRef.current) {
        setErrorMessage("Position indisponible -- réessayez.");
        setStatus('error');
      }
      return;
    }

    const queued = await pendingIncidentQueue.enqueue({
      rideId,
      latitude: location.position.latitude,
      longitude: location.position.longitude,
      triggeredAt: new Date().toISOString(),
    });

    const outcome = await submitOnce(queued);
    if (!mountedRef.current) return;
    if (outcome === 'network-failure') {
      setStatus('queued');
    } else if (outcome === 'business-error') {
      setStatus('error');
    } else {
      setStatus('sent');
    }
  }, [rideId, submitOnce]);

  const label =
    status === 'sent'
      ? 'Alerte envoyée'
      : status === 'queued'
        ? 'Alerte en file -- envoi dès que possible'
        : status === 'sending'
          ? 'Envoi…'
          : status === 'holding'
            ? 'Maintenez…'
            : 'Urgence';

  return (
    <View style={styles.container}>
      <Pressable
        testID="emergency-button"
        accessibilityRole="button"
        accessibilityLabel="Bouton d'urgence -- maintenir pour alerter"
        disabled={status === 'sending'}
        onPressIn={() => setStatus((current) => (current === 'idle' || current === 'error' ? 'holding' : current))}
        onPressOut={() => setStatus((current) => (current === 'holding' ? 'idle' : current))}
        delayLongPress={HOLD_MS}
        onLongPress={trigger}
        style={({ pressed }) => [
          styles.button,
          status === 'holding' || pressed ? styles.buttonHolding : null,
          (status === 'sent' || status === 'queued') ? styles.buttonSent : null,
        ]}
      >
        <Text style={styles.buttonLabel} testID="emergency-button-label">{label}</Text>
      </Pressable>
      {errorMessage ? (
        <Text style={styles.error} testID="emergency-error">
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
    minWidth: 96,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonHolding: {
    backgroundColor: '#991B1B',
  },
  buttonSent: {
    backgroundColor: '#6B7280',
  },
  buttonLabel: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  error: {
    color: '#DC2626',
    fontSize: 11,
    maxWidth: 160,
    textAlign: 'center',
  },
});
