import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, translateApiError, flushPendingIncidentTriggers, type PendingIncidentTrigger } from '@babana/api-client';
import { apiClient } from '../auth';
import { pendingIncidentQueue } from '../incidentQueue';

/**
 * Bouton d'urgence, côté chauffeur (L8-04). Même logique que `apps/client/src/components/
 * EmergencyButton.tsx` -- appui long, file locale hors connexion, rejeu au montage -- à une
 * différence près : `getPosition` est injecté plutôt qu'importé directement.
 *
 * **Pourquoi l'injection, pas `@react-native-community/geolocation` en dur comme côté client** :
 * l'app Chauffeur n'a encore aucun écran de course en cours (L6-11 à L6-14, jamais construites --
 * voir amoa/questions/L8-04-driver-screen-gap.md) pour monter ce composant. Sans écran hôte, il
 * n'y a personne pour décider SI ce chauffeur doit rappeler le GPS à l'instant ou réutiliser la
 * dernière position déjà en vol vers le service temps réel (l'app chauffeur émet déjà
 * `position.update` en continu pendant une course, L3-01/L3-02) -- ce choix appartient à
 * l'écran qui finira par exister, pas à ce composant. L'injection le rend utilisable dès
 * aujourd'hui, testable sans dépendance de géolocalisation, et prêt à recevoir l'une ou l'autre
 * source le jour venu, sans changer sa propre logique.
 */

type Status = 'idle' | 'holding' | 'sending' | 'sent' | 'queued' | 'error';

const HOLD_MS = 800;

export interface EmergencyButtonProps {
  rideId: string;
  /** Position au déclenchement (critère d'acceptation 2) -- `null` si indisponible, jamais
   * inventée. */
  getPosition: () => Promise<{ latitude: number; longitude: number } | null>;
}

export function EmergencyButton({ rideId, getPosition }: EmergencyButtonProps) {
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
        await pendingIncidentQueue.remove(trigger.idempotencyKey);
        if (mountedRef.current) setErrorMessage(translateApiError(error));
        return 'business-error';
      }
      return 'network-failure';
    }
  }, []);

  const flushOne = useCallback(
    async (trigger: PendingIncidentTrigger) => (await submitOnce(trigger)) !== 'network-failure',
    [submitOnce]
  );

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

    const position = await getPosition();
    if (!position) {
      if (mountedRef.current) {
        setErrorMessage('Position indisponible -- réessayez.');
        setStatus('error');
      }
      return;
    }

    const queued = await pendingIncidentQueue.enqueue({
      rideId,
      latitude: position.latitude,
      longitude: position.longitude,
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
  }, [rideId, getPosition, submitOnce]);

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
