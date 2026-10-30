import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { asRideId } from '@babana/navigation';
import { ApiError, USER_MESSAGES, translateApiError, type ConnectionState } from '@babana/api-client';
import { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { FARE_LINES } from '../components/fareBreakdown';
import { formatDistance, formatEta, formatMoney } from '../format';
import { onRealtimeConnectionStateChange, realtimeClient } from '../realtime';
import { replaceWithRideFlow } from '../navigation/transitions';
import type { ClientParamList } from '../navigation/types';

/**
 * Écran d'estimation et de commande (L6-07). Montant, détail décomposé, distance et durée
 * corrigée, un repère facultatif, puis « Commander » -- un seul geste. Le client ne choisit pas son
 * chauffeur : la course part au plus proche disponible, choisi par le serveur (D10 retiré). La
 * recherche elle-même démarre sur l'écran d'attente, qui sait aussi la relancer (« Réessayer »).
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
 * Validité restante, comptée depuis la RÉCEPTION de l'estimation avec la durée envoyée par le
 * serveur (`validForSeconds`) -- jamais `expiresAt` comparé à l'horloge du téléphone, souvent
 * fausse sur un terminal d'entrée de gamme (« Valable 1476 min », constaté le 26 octobre). Seul
 * l'écart entre deux lectures de l'horloge compte ici, pas sa valeur absolue.
 */
function remainingSeconds(quote: http.QuoteResponse, receivedAt: number): number {
  return Math.max(0, Math.round(quote.validForSeconds - (Date.now() - receivedAt) / 1000));
}

export function QuoteScreen({ route, navigation }: Props) {
  const { origin, destination } = route.params;
  const [vehicleClass, setVehicleClass] = useState<http.VehicleClass>('standard');
  const [quote, setQuote] = useState<http.QuoteResponse | null>(null);
  const receivedAt = useRef(0);
  const [loading, setLoading] = useState(true);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  // Repère libre pour le chauffeur (« devant la pharmacie ») : l'adresse formelle n'existe presque
  // pas à Douala. Facultatif, envoyé avec la commande seulement s'il n'est pas vide.
  const [pickupNote, setPickupNote] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // Suivi uniquement pour affiner le message d'échec de la commande (L6-16, "actions interdites
  // hors connexion" : une commande n'est jamais mise en file, elle échoue vite -- mais un client
  // hors connexion mérite de le savoir plutôt qu'un « réessayez » générique).
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
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
        receivedAt.current = Date.now();
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

  useEffect(() => onRealtimeConnectionStateChange(setConnectionState), []);

  // Compte à rebours de validité (spécification) -- un tick par seconde suffit pour une fenêtre
  // de l'ordre de quelques minutes.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!quote) return;
    if (remainingSeconds(quote, receivedAt.current) <= 0) {
      setExpired(true);
      return;
    }
    const timer = setInterval(() => {
      if (remainingSeconds(quote, receivedAt.current) <= 0) {
        setExpired(true);
      } else {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [quote]);

  async function handleOrder() {
    if (!quote || expired || ordering) return;
    setOrdering(true);
    setOrderError(null);
    try {
      const note = pickupNote.trim();
      const ride = (await apiClient.request('createRide', {
        body: note ? { quoteId: quote.quoteId, pickupNote: note } : { quoteId: quote.quoteId },
      })) as http.CreateRideResponse;
      // Le piège du bouton retour Android (L6-00, `navigation/transitions.ts`) : la pile
      // Home/Quote est remplacée, pas empilée sous Waiting -- un retour depuis l'attente ne doit
      // jamais ramener à l'estimation d'une course qui existe désormais côté serveur. La recherche
      // du chauffeur démarre là-bas : c'est aussi là qu'elle se relance après « aucun chauffeur ».
      replaceWithRideFlow(navigation, {
        rideId: asRideId(ride.id),
        amount: ride.amount,
        origin,
        destination,
        requestedAt: Date.now(),
      });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setOrderError(translateApiError(cause));
      } else if (connectionState !== 'connected') {
        // Commander est interdit hors connexion (L6-16, spécification) : jamais mis en file,
        // jamais rejoué seul -- la course partirait à un chauffeur au moment où le client ne
        // l'attend plus.
        setOrderError('Hors connexion : la commande nécessite une connexion. Réessayez une fois reconnecté.');
      } else {
        setOrderError('La commande a échoué. Réessayez.');
      }
      setOrdering(false);
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
          <Text style={styles.payment} testID="quote-payment">
            Paiement en espèces au chauffeur
          </Text>
          <Text
            style={[styles.pickupEta, quote.pickupEtaSeconds === null && styles.pickupEtaNone]}
            testID="quote-pickup-eta"
          >
            {quote.pickupEtaSeconds === null
              ? 'Aucune moto à proximité pour le moment'
              : `Moto à ${formatEta(quote.pickupEtaSeconds)}`}
          </Text>
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
              Valable {Math.max(1, Math.ceil(remainingSeconds(quote, receivedAt.current) / 60))} min
            </Text>
          )}
        </View>
      ) : null}

      {quote && !loading && !expired ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>Un repère pour le chauffeur (facultatif)</Text>
          <TextInput
            testID="pickup-note-input"
            value={pickupNote}
            onChangeText={setPickupNote}
            placeholder="Ex. : devant la pharmacie du rond-point"
            placeholderTextColor="#9CA3AF"
            maxLength={http.PICKUP_NOTE_MAX_LENGTH}
            style={styles.noteInput}
            returnKeyType="done"
          />
        </View>
      ) : null}

      {orderError ? <Text style={styles.errorText}>{orderError}</Text> : null}

      <Button
        testID="order-button"
        label={ordering ? 'Commande…' : 'Commander'}
        onPress={handleOrder}
        disabled={!quote || loading || expired || ordering}
      />
      <Text style={styles.dispatchHint}>La course part au chauffeur disponible le plus proche.</Text>
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
  payment: {
    color: '#374151',
    fontWeight: '600',
  },
  pickupEta: {
    color: '#137347',
    fontWeight: '700',
  },
  pickupEtaNone: {
    color: '#8A5A00',
  },
  tripMeta: {
    color: '#6B7280',
  },
  validity: {
    fontSize: 12,
    color: '#6B7280',
  },
  noteBox: {
    gap: 6,
  },
  noteLabel: {
    color: '#374151',
    fontWeight: '600',
  },
  noteInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#1F2937',
    backgroundColor: '#FFFFFF',
  },
  errorBox: {
    gap: 8,
    alignItems: 'flex-start',
  },
  errorText: {
    color: '#B91C1C',
  },
  dispatchHint: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
  },
});
