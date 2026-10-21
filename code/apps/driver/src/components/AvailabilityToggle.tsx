import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { buttonLabels, buttons, cards, colors } from '../theme';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { locationTracker } from '../location';
import { realtimeClient } from '../realtime';

/**
 * Bascule en ligne / hors ligne (L6-11, D7). Cible tactile large (D20, exigence non esthétique) :
 * le chauffeur est sur sa moto, parfois avec des gants -- même discipline que
 * `EmergencyButton.tsx` (Pressable dimensionné directement, pas le `Button` générique de
 * `@babana/ui`, pensé pour un usage assis).
 *
 * **Aucune décision ici, seulement l'application de celle du serveur** (invariant 3) : Odoo
 * reste seul juge de l'éligibilité (L3-04) -- ce composant se contente d'afficher le motif exact
 * que le serveur renvoie (`translateApiError`, un code -> une phrase, catalogue C-01).
 *
 * **Deux appels, pas un** (constaté en vérifiant cet écran dans un navigateur, contre la vraie
 * pile) : `POST /drivers/me/availability` (Odoo) ne décide que de l'autorisation -- ni
 * `services/odoo/addons/babana/controllers/driver.py` ni `ws/dispatch.ts` (service temps réel)
 * n'appliquent seuls l'un sans l'autre. L'insertion réelle dans le géo-index (le drapeau
 * `is_online` côté Redis, `driver/availability.ts::setOnline`) n'a lieu qu'au message
 * `availability.set` (C-02), envoyé ici une fois l'autorisation d'Odoo obtenue -- jamais avant
 * (un chauffeur refusé ne doit jamais apparaître disponible, même un instant), jamais à sa place
 * (l'appel HTTP seul ne fait rien apparaître dans le pool).
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
      // Odoo a autorisé -- applique réellement l'état côté service temps réel (voir le
      // commentaire de tête). Toujours après l'autorisation, jamais avant.
      realtimeClient.send('availability.set', { online: response.online });
      // L6-05 : la capture GPS suit le même instant -- démarre ou s'arrête immédiatement avec la
      // disponibilité, jamais avant (un chauffeur refusé ne doit jamais capturer sa position) ni
      // en retard (arrêt immédiat au passage hors ligne, spécification).
      locationTracker.setOnline(response.online);
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
        <View testID="availability-dot" style={[styles.dot, online ? styles.dotOnline : styles.dotOffline]} />
        <Text style={[styles.toggleLabel, online ? styles.toggleLabelOnline : null]} testID="availability-status">
          {pending ? 'Mise à jour…' : online ? 'En ligne' : 'Hors ligne'}
        </Text>
      </Pressable>

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
  // Compact et doux : pilule de 48 dp (cible tactile minimale, D20 -- le chauffeur porte des
  // gants), même forme que tous les boutons de l'app ; état porté par une pastille ET un libellé.
  toggle: {
    ...buttons.base,
    ...buttons.md,
    ...buttons.floating,
    minWidth: 128,
    paddingHorizontal: 16,
  },
  toggleOnline: buttons.brandSoft,
  toggleOffline: buttons.secondary,
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotOnline: {
    backgroundColor: colors.brand,
  },
  dotOffline: {
    backgroundColor: colors.subtle,
  },
  toggleDisabled: buttons.disabled,
  togglePressed: buttons.pressed,
  toggleLabel: {
    ...buttonLabels.base,
    color: colors.inkSoft,
  },
  toggleLabelOnline: {
    color: colors.brandText,
  },
  // Messages sous la bascule : une carte douce, jamais du texte nu posé sur la carte.
  explanation: {
    ...cards.floating,
    color: colors.warningText,
    backgroundColor: colors.warningSoft,
    textAlign: 'center',
    maxWidth: 260,
    paddingHorizontal: 12,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  refusal: {
    ...cards.floating,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    gap: 8,
    maxWidth: 280,
    padding: 12,
  },
  refusalText: {
    color: colors.dangerText,
    textAlign: 'center',
  },
  remittanceButton: {
    ...buttons.base,
    ...buttons.md,
    ...buttons.primary,
    ...buttons.floating,
    minWidth: 200,
  },
  remittanceButtonLabel: {
    ...buttonLabels.base,
    ...buttonLabels.primary,
  },
});
