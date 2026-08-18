import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { asRideId } from '@babana/navigation';
import { ApiError, USER_MESSAGES, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { DriverCard } from '../components/DriverCard';
import type { ClientParamList } from '../navigation/types';

/**
 * Écran d'estimation et de choix du chauffeur (L6-07, D10, D14). Montant, détail décomposé,
 * distance et durée corrigée d'abord ; les 5 chauffeurs ensuite -- le client touche une carte
 * pour choisir, il n'y a pas de second geste de confirmation (même principe que L6-08 : chaque
 * étape ajoutée est un abandon de plus).
 *
 * **Aucun calcul de tarif ici** (critère 5) : `quote` est affiché tel que reçu, jamais recomposé.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Quote'>;

const VEHICLE_CLASSES: readonly http.VehicleClass[] = ['standard', 'premium'];
const VEHICLE_CLASS_LABELS: Record<http.VehicleClass, string> = {
  standard: 'Standard',
  premium: 'Confort',
};

/**
 * Détail décomposé (spécification : « prise en charge, distance, coefficient éventuel, remise »).
 * `floorAmount` et `roundingAmount` complètent la liste pour que les lignes affichées somment
 * *exactement* le total affiché (L2-03, critère 4) -- masquées quand nulles pour ne pas
 * encombrer un montant sans surprise, jamais réarrondies : additionner zéro ne change rien à la
 * somme, donc l'identité tient qu'une ligne nulle soit montrée ou non.
 */
const FARE_LINES: ReadonlyArray<{ key: keyof http.FareBreakdown; label: string; subtract?: boolean; alwaysShown?: boolean }> = [
  { key: 'baseFare', label: 'Prise en charge', alwaysShown: true },
  { key: 'distanceFare', label: 'Distance', alwaysShown: true },
  { key: 'surgeAmount', label: 'Majoration' },
  { key: 'discountAmount', label: 'Remise', subtract: true },
  { key: 'floorAmount', label: 'Ajustement plancher' },
  { key: 'roundingAmount', label: 'Arrondi' },
];

function formatMoney(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

function formatEta(etaSeconds: number): string {
  // La durée vient d'un modèle voiture corrigé côté serveur (É8, L10-03) par un facteur qui vaut
  // 1.0 aujourd'hui -- non calibré. "≈" et l'arrondi à la minute évitent d'afficher une précision
  // que ce chiffre n'a pas.
  return `≈ ${Math.max(1, Math.round(etaSeconds / 60))} min`;
}

function formatDistance(distanceMeters: number): string {
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function QuoteScreen({ route, navigation }: Props) {
  const { origin, destination, nearbyDrivers } = route.params;
  const [vehicleClass, setVehicleClass] = useState<http.VehicleClass>('standard');
  const [quote, setQuote] = useState<http.QuoteResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  // Écarte la réponse d'une requête d'estimation déjà remplacée (changement de gamme, ou
  // réactualisation après expiration) -- même principe que HomeScreen pour nearby.subscribe.
  const requestId = useRef(0);

  const fetchQuote = useCallback(
    async (targetClass: http.VehicleClass) => {
      const thisRequest = ++requestId.current;
      setLoading(true);
      setQuoteError(null);
      setExpired(false);
      try {
        const response = (await apiClient.request('quote', {
          body: { origin: origin.position, destination: destination.position, vehicleClass: targetClass },
        })) as http.QuoteResponse;
        if (requestId.current !== thisRequest) return;
        setQuote(response);
      } catch (cause) {
        if (requestId.current !== thisRequest) return;
        setQuote(null);
        setQuoteError(cause instanceof ApiError ? translateApiError(cause) : "L'estimation a échoué. Réessayez.");
      } finally {
        if (requestId.current === thisRequest) setLoading(false);
      }
    },
    [origin.position, destination.position]
  );

  useEffect(() => {
    fetchQuote(vehicleClass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleClass]);

  // Compte à rebours de validité (spécification) -- un tick par seconde suffit pour une fenêtre
  // de l'ordre de quelques minutes.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!quote) return;
    if (remainingSeconds(quote.expiresAt) <= 0) {
      setExpired(true);
      return;
    }
    const timer = setInterval(() => {
      if (remainingSeconds(quote.expiresAt) <= 0) {
        setExpired(true);
      } else {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [quote]);

  async function handleSelectDriver(driverId: string) {
    if (!quote || expired || selecting) return;
    setSelecting(true);
    setSelectError(null);
    try {
      const ride = (await apiClient.request('createRide', {
        body: { quoteId: quote.quoteId },
      })) as http.CreateRideResponse;
      const proposal = (await apiClient.request('selectDriver', {
        pathParams: { id: ride.id },
        body: { driverId },
      })) as http.SelectDriverResponse;
      navigation.navigate('Waiting', { rideId: asRideId(proposal.id) });
    } catch (cause) {
      setSelectError(cause instanceof ApiError ? translateApiError(cause) : 'La sélection a échoué. Réessayez.');
      setSelecting(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.pointsSummary}>
        <Text style={styles.pointText} numberOfLines={1}>
          Départ : {origin.label}
        </Text>
        <Text style={styles.pointText} numberOfLines={1}>
          Arrivée : {destination.label}
        </Text>
      </View>

      <View style={styles.classRow}>
        {VEHICLE_CLASSES.map((candidate) => (
          <Button
            key={candidate}
            testID={`vehicle-class-${candidate}`}
            label={VEHICLE_CLASS_LABELS[candidate]}
            variant={candidate === vehicleClass ? 'primary' : 'secondary'}
            onPress={() => setVehicleClass(candidate)}
          />
        ))}
      </View>

      {loading ? <ActivityIndicator testID="quote-loading" size="large" /> : null}

      {quoteError && !loading ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{quoteError}</Text>
          <Button testID="retry-quote" label="Réessayer" variant="secondary" onPress={() => fetchQuote(vehicleClass)} />
        </View>
      ) : null}

      {quote && !loading ? (
        <View style={styles.quoteBox} testID="quote-box">
          {/* D20 : le montant et le détail dominent l'écran -- pas une exigence esthétique. */}
          <Text style={styles.amount}>{formatMoney(quote.amount)}</Text>
          <View style={styles.breakdown} testID="fare-breakdown">
            {FARE_LINES.filter((line) => line.alwaysShown || quote.breakdown[line.key] !== 0).map((line) => (
              <View style={styles.breakdownRow} key={line.key}>
                <Text style={styles.breakdownLabel}>{line.label}</Text>
                <Text style={styles.breakdownValue}>
                  {`${line.subtract ? '-' : ''}${formatMoney(Math.abs(Number(quote.breakdown[line.key])))}`}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.tripMeta}>
            {formatDistance(quote.distanceMeters)} · {formatEta(quote.etaSeconds)}
          </Text>

          {expired ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{USER_MESSAGES.QUOTE_EXPIRED}</Text>
              <Button testID="refresh-quote" label="Réactualiser" variant="secondary" onPress={() => fetchQuote(vehicleClass)} />
            </View>
          ) : (
            <Text style={styles.validity} testID="quote-validity">
              Valable {Math.max(1, Math.ceil(remainingSeconds(quote.expiresAt) / 60))} min
            </Text>
          )}
        </View>
      ) : null}

      {selectError ? <Text style={styles.errorText}>{selectError}</Text> : null}

      <View style={styles.driversList}>
        {nearbyDrivers.map((driver) => (
          <DriverCard key={driver.driverId} driver={driver} onSelect={handleSelectDriver} disabled={!quote || expired || selecting} />
        ))}
      </View>
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
  pointsSummary: {
    gap: 4,
  },
  pointText: {
    color: '#374151',
  },
  classRow: {
    flexDirection: 'row',
    gap: 8,
  },
  quoteBox: {
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
  validity: {
    fontSize: 12,
    color: '#6B7280',
  },
  errorBox: {
    gap: 8,
    alignItems: 'flex-start',
  },
  errorText: {
    color: '#B91C1C',
  },
  driversList: {
    gap: 8,
  },
});
