import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';

/**
 * Bascule en ligne / hors ligne (L6-11, D7). Cible tactile large (D20, exigence non esthétique) :
 * le chauffeur est sur sa moto, parfois avec des gants -- même discipline que
 * `EmergencyButton.tsx` (Pressable dimensionné directement, pas le `Button` générique de
 * `@babana/ui`, pensé pour un usage assis).
 *
 * **Aucune décision ici, seulement l'application de celle du serveur** (invariant 3) : Odoo
 * reste seul juge de l'éligibilité (L3-04) -- ce composant se contente d'afficher le motif exact
 * que le serveur renvoie (`translateApiError`, un code -> une phrase, catalogue C-01).
 */
export interface AvailabilityToggleProps {
  /**
   * Un chauffeur en course ne peut pas se mettre hors ligne depuis cet écran (L3-04, critère 2)
   * -- lu depuis `session.synced` (`activeRideState`) par l'écran appelant, jamais deviné ici :
   * ce composant ne porte aucun état de course.
   */
  inCourse: boolean;
  /** Le motif de refus est le plafond d'encaisse -- propose l'accès à la déclaration de remise
   * (L5-07). Écarté ce soir (amoa/questions/L6-11.md) : L5-07 n'a pas encore d'écran, cette
   * fonction navigue vers l'espace réservé qui l'attend (même discipline que L8-04 pour
   * `getPosition`, injecté plutôt que supposé). */
  onNavigateToRemittance: () => void;
}

export function AvailabilityToggle({ inCourse, onNavigateToRemittance }: AvailabilityToggleProps) {
  const [online, setOnline] = useState(false);
  const [pending, setPending] = useState(false);
  const [refusalError, setRefusalError] = useState<ApiError | null>(null);
  const [networkError, setNetworkError] = useState(false);

  const disabled = inCourse || pending;

  async function toggle() {
    // Filet défensif : `Pressable`'s `disabled` empêche déjà l'appui réel d'atteindre `onPress`,
    // mais rien ne garantit qu'un appelant (ou un test) ne rappelle jamais cette fonction
    // directement pendant que l'interrupteur doit rester inerte (en course, ou une requête déjà
    // en vol) -- une bascule qui partirait quand même serait exactement ce que le critère 3
    // interdit.
    if (disabled) return;
    const next = !online;
    setPending(true);
    setRefusalError(null);
    setNetworkError(false);
    try {
      const response = (await apiClient.request('setAvailability', { body: { online: next } })) as http.SetAvailabilityResponse;
      setOnline(response.online);
    } catch (error) {
      if (error instanceof ApiError) {
        setRefusalError(error);
      } else {
        setNetworkError(true);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.container}>
      <Pressable
        testID="availability-toggle"
        accessibilityRole="switch"
        accessibilityLabel={online ? 'En ligne -- appuyer pour se mettre hors ligne' : 'Hors ligne -- appuyer pour se mettre en ligne'}
        accessibilityState={{ checked: online, disabled }}
        disabled={disabled}
        onPress={toggle}
        style={({ pressed }) => [
          styles.toggle,
          online ? styles.toggleOnline : styles.toggleOffline,
          disabled ? styles.toggleDisabled : null,
          pressed && !disabled ? styles.togglePressed : null,
        ]}
      >
        <Text style={styles.toggleLabel} testID="availability-status">
          {pending ? 'Mise à jour…' : online ? 'En ligne' : 'Hors ligne'}
        </Text>
      </Pressable>

      {inCourse ? (
        <Text style={styles.explanation} testID="availability-in-course-explanation">
          Vous ne pouvez pas repasser hors ligne pendant une course.
        </Text>
      ) : null}

      {refusalError ? (
        <View style={styles.refusal} testID="availability-refusal">
          <Text style={styles.refusalText}>{translateApiError(refusalError)}</Text>
          {refusalError.code === 'CASH_LIMIT_REACHED' ? (
            <Pressable testID="availability-go-to-remittance" accessibilityRole="button" onPress={onNavigateToRemittance} style={styles.remittanceButton}>
              <Text style={styles.remittanceButtonLabel}>Faire une remise</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {networkError ? (
        <Text style={styles.explanation} testID="availability-network-error">
          La mise à jour a échoué. Réessayez.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 8,
  },
  toggle: {
    minWidth: 220,
    minHeight: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  toggleOnline: {
    backgroundColor: '#0A7D3D',
  },
  toggleOffline: {
    backgroundColor: '#6B7280',
  },
  toggleDisabled: {
    opacity: 0.5,
  },
  togglePressed: {
    opacity: 0.85,
  },
  toggleLabel: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  explanation: {
    color: '#374151',
    textAlign: 'center',
    maxWidth: 260,
  },
  refusal: {
    alignItems: 'center',
    gap: 8,
    maxWidth: 280,
  },
  refusalText: {
    color: '#B91C1C',
    textAlign: 'center',
  },
  remittanceButton: {
    minHeight: 56,
    minWidth: 200,
    borderRadius: 8,
    backgroundColor: '#0A7D3D',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  remittanceButtonLabel: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
  },
});
