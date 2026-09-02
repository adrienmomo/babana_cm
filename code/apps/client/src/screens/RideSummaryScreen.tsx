import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { ApiError, translateApiError } from '@babana/api-client';
import { offlineRunner } from '../offline';
import { visibleFareLines } from '../components/fareBreakdown';
import { formatDistance, formatMoney } from '../format';
import type { ClientParamList } from '../navigation/types';

/**
 * Résumé de fin de course (L6-09). **Ce que le serveur a écrit dans `ride.completed`, jamais ce
 * que l'app a accumulé pendant le suivi** (spécification) : `route.params` porte les mêmes
 * chiffres que le message reçu par TrackingScreen, transmis tels quels -- c'est ce qu'un client
 * relira en cas de litige.
 *
 * **Aucune immatriculation ni identité du chauffeur ici** -- décision explicite (doute du 26 août,
 * amoa/questions/REPONSES-2026-08-26.md §5) : ces données vivent exclusivement dans les
 * paramètres de route de `Tracking`, qui a disparu de la pile (`navigation.replace`) au moment
 * où cet écran se monte. Rien à effacer explicitement, il n'y a simplement plus rien qui la porte.
 *
 * **La notation est autorisée hors connexion** (L6-16, spécification) : `handleSubmitRating`
 * passe par `offlineRunner`, jamais `apiClient` directement -- mise en file automatique sur un
 * réseau absent, rejouée à la reconnexion avec la même clé d'idempotence. `rateRide` reste sans
 * implémentation côté serveur ce soir (`babana.rating`, L4-09, hors périmètre) -- la file
 * fonctionnera dès que ce modèle existera, rien à refaire côté app à ce moment-là.
 */

type Props = NativeStackScreenProps<ClientParamList, 'RideSummary'>;

const RATING_VALUES = [1, 2, 3, 4, 5] as const;

function formatDuration(durationSeconds: number): string {
  return `${Math.max(1, Math.round(durationSeconds / 60))} min`;
}

/**
 * Trajet non relevé (J24, amoa/questions/L6-13.md) : `distanceMeters` / `durationSeconds` sont
 * `null` quand le service temps réel n'a pas accumulé le trajet (`measured === false`). On
 * l'affiche comme tel -- « Trajet non relevé » -- plutôt qu'un « 0 m · 1 min » qui aurait
 * l'aplomb d'un fait sur le résumé qu'un client relira en cas de litige (D30, D43).
 */
function formatTripMeta(distanceMeters: number | null, durationSeconds: number | null): string {
  if (distanceMeters === null || durationSeconds === null) return 'Trajet non relevé';
  return `${formatDistance(distanceMeters)} · ${formatDuration(durationSeconds)}`;
}

export function RideSummaryScreen({ route, navigation }: Props) {
  const { rideId, distanceMeters, durationSeconds, amount, breakdown } = route.params;

  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitQueued, setSubmitQueued] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmitRating() {
    if (rating === null || submitting || submitQueued) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await offlineRunner.attempt('rateRide', {
        pathParams: { id: rideId },
        body: comment.trim() ? { rating, comment: comment.trim() } : { rating },
        // Synchrone, avant que la promesse ci-dessus ne se résolve (échec réseau) -- l'attente
        // peut durer jusqu'à la prochaine reconnexion.
        onQueued: () => {
          setSubmitting(false);
          setSubmitQueued(true);
        },
      });
      setSubmitted(true);
    } catch (cause) {
      // Une erreur réseau ne fait jamais rejeter cette promesse (mise en file à la place,
      // ci-dessus) -- seule reste une erreur métier.
      setSubmitError(cause instanceof ApiError ? translateApiError(cause) : "L'envoi de la note a échoué. Réessayez.");
      setSubmitQueued(false);
    } finally {
      setSubmitting(false);
    }
  }

  function handleRetryNow() {
    // Ne relance pas `handleSubmitRating()` -- l'envoi initial reste en attente dans
    // `offlineRunner` avec sa propre clé d'idempotence ; `flush()` retente ce qui est déjà en
    // file, sans en créer une seconde.
    // `flush()` ne rejette jamais (manager.ts -- une reconnexion future réessaiera), le `catch`
    // ici n'est qu'une garde contre un rejet imprévu ; rien de plus à faire depuis un écran.
    offlineRunner.flush().catch(() => {});
  }

  function handleDone() {
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Course terminée</Text>

      <View style={styles.amountBox} testID="ride-summary-amount-box">
        <Text style={styles.amount}>{formatMoney(amount)}</Text>
        <View style={styles.breakdown} testID="ride-summary-breakdown">
          {visibleFareLines(breakdown).map((line) => (
            <View style={styles.breakdownRow} key={line.key}>
              <Text style={styles.breakdownLabel}>{line.label}</Text>
              <Text style={styles.breakdownValue}>
                {`${line.subtract ? '-' : ''}${formatMoney(Math.abs(Number(breakdown[line.key])))}`}
              </Text>
            </View>
          ))}
        </View>
        <Text style={styles.tripMeta} testID="ride-summary-trip-meta">
          {formatTripMeta(distanceMeters, durationSeconds)}
        </Text>
      </View>

      <View style={styles.ratingBox} testID="rating-box">
        <Text style={styles.ratingTitle}>Comment s'est passée votre course ?</Text>
        <View style={styles.stars}>
          {RATING_VALUES.map((value) => (
            <Pressable
              key={value}
              testID={`rating-star-${value}`}
              accessibilityRole="button"
              accessibilityLabel={`Noter ${value} sur 5`}
              disabled={submitting || submitted}
              onPress={() => setRating(value)}
            >
              <Text style={[styles.star, rating !== null && value <= rating ? styles.starFilled : null]}>★</Text>
            </Pressable>
          ))}
        </View>

        {submitted ? (
          <Text style={styles.thanksText} testID="rating-thanks">
            Merci pour votre note !
          </Text>
        ) : submitQueued ? (
          <View testID="rating-queued">
            <Text style={styles.queuedText}>
              Note en attente — elle sera envoyée dès que la connexion revient.
            </Text>
            <Button testID="rating-retry" label="Réessayer maintenant" variant="secondary" onPress={handleRetryNow} />
          </View>
        ) : (
          <>
            <TextInput
              testID="rating-comment"
              style={styles.commentInput}
              placeholder="Un commentaire (optionnel)"
              value={comment}
              onChangeText={setComment}
              maxLength={500}
              multiline
              editable={!submitting}
            />
            {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
            <Button
              testID="submit-rating"
              label="Envoyer la note"
              variant="secondary"
              onPress={handleSubmitRating}
              disabled={rating === null || submitting}
            />
          </>
        )}
      </View>

      <Button testID="view-invoice" label="Voir la facture" variant="secondary" onPress={() => navigation.navigate('Invoice', { rideId })} />
      <Button testID="ride-summary-done" label="Terminer" onPress={handleDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  amountBox: {
    gap: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
  },
  amount: {
    fontSize: 32,
    fontWeight: '700',
  },
  breakdown: {
    gap: 2,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  breakdownLabel: {
    color: '#374151',
  },
  breakdownValue: {
    color: '#374151',
    fontVariant: ['tabular-nums'],
  },
  tripMeta: {
    color: '#6B7280',
  },
  ratingBox: {
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  ratingTitle: {
    fontWeight: '600',
  },
  stars: {
    flexDirection: 'row',
    gap: 8,
  },
  star: {
    fontSize: 32,
    color: '#D1D5DB',
  },
  starFilled: {
    color: '#F59E0B',
  },
  commentInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 8,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#B91C1C',
  },
  thanksText: {
    color: '#0A7D3D',
    fontWeight: '600',
  },
  queuedText: {
    color: '#92400E',
    marginBottom: 8,
  },
});
