import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { ApiError, translateApiError } from '@babana/api-client';
import { apiClient } from '../auth';
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
 */

type Props = NativeStackScreenProps<ClientParamList, 'RideSummary'>;

const RATING_VALUES = [1, 2, 3, 4, 5] as const;

function formatDuration(durationSeconds: number): string {
  return `${Math.max(1, Math.round(durationSeconds / 60))} min`;
}

export function RideSummaryScreen({ route, navigation }: Props) {
  const { rideId, distanceMeters, durationSeconds, amount, breakdown } = route.params;

  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmitRating() {
    if (rating === null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiClient.request('rateRide', {
        pathParams: { id: rideId },
        body: comment.trim() ? { rating, comment: comment.trim() } : { rating },
      });
      setSubmitted(true);
    } catch (cause) {
      setSubmitError(cause instanceof ApiError ? translateApiError(cause) : "L'envoi de la note a échoué. Réessayez.");
    } finally {
      setSubmitting(false);
    }
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
        <Text style={styles.tripMeta}>
          {formatDistance(distanceMeters)} · {formatDuration(durationSeconds)}
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

        {!submitted ? (
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
        ) : (
          <Text style={styles.thanksText} testID="rating-thanks">
            Merci pour votre note !
          </Text>
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
});
