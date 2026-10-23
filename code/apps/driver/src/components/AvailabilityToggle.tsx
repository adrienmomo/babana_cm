import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { buttonLabels, buttons, colors, radius } from '../theme';
import { SwipeButton } from './SwipeButton';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { locationTracker } from '../location';
import { realtimeClient } from '../realtime';

/**
 * Bascule en ligne / hors ligne (L6-11, D7). Un curseur à glisser sur toute la largeur (D20,
 * exigence non esthétique) : le chauffeur est sur sa moto, parfois avec des gants -- un geste
 * ample se fait sans viser, et ne part pas d'un effleurement (`SwipeButton.tsx`).
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
  // Repart de l'état réellement appliqué (la capture GPS suit la disponibilité, L6-05), jamais
  // de « hors ligne » par défaut : l'accueil est remonté après l'encaissement, et un chauffeur
  // toujours en ligne se croyait alors hors service.
  const [online, setOnline] = useState(() => locationTracker.getState() !== 'offline');
  const [pending, setPending] = useState(false);
  const [refusalError, setRefusalError] = useState<ApiError | null>(null);
  const [networkError, setNetworkError] = useState(false);

  // La disponibilité peut changer sans cette bascule : le serveur met hors ligne un chauffeur
  // resté déconnecté au-delà de la période de grâce, et le lui dit à la reconnexion
  // (`session.synced`, appliqué par LocationTracker). L'affichage suit, sans rien redemander.
  useEffect(() => locationTracker.subscribeOnline(setOnline), []);

  const disabled = inCourse || pending;

  async function toggle() {
    // Filet défensif : le `disabled` du curseur empêche déjà le geste réel d'atteindre `onConfirm`,
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
      {/* Un glissement, pas un appui : passer hors ligne par un effleurement de poche ferait
          disparaître le chauffeur du pool sans qu'il le sache. L'état courant est dans le libellé
          (« Hors ligne » / « En ligne ») et dans la teinte -- jamais la couleur seule. */}
      <SwipeButton
        testID="availability-toggle"
        labelTestID="availability-status"
        variant={online ? 'soft' : 'primary'}
        label={pending ? 'Mise à jour…' : online ? 'En ligne · glisser pour arrêter' : 'Hors ligne · glisser pour démarrer'}
        accessibilityLabel={online ? 'En ligne -- glisser pour se mettre hors ligne' : 'Hors ligne -- glisser pour se mettre en ligne'}
        disabled={disabled}
        onConfirm={toggle}
      />

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
  // Pleine largeur du panneau du bas (HomeScreen) : le curseur a toute la place pour glisser.
  container: {
    alignSelf: 'stretch',
    gap: 8,
  },
  // Messages sous la bascule : un encart doux, jamais du texte nu.
  explanation: {
    borderRadius: radius.field,
    color: colors.warningText,
    backgroundColor: colors.warningSoft,
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  refusal: {
    borderRadius: radius.field,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    gap: 8,
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
