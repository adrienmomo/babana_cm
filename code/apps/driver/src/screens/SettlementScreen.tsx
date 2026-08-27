import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, generateIdempotencyKey, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { formatMoney } from '../format';
import { replaceWithHome } from '../navigation/transitions';
import type { DriverParamList } from '../navigation/types';

/**
 * Confirmation d'encaissement espèces (L6-14, D9).
 *
 * **Le chauffeur confirme un chiffre, il n'en déclare pas un** (L4-05) : le montant affiché est
 * celui qui est dû (transmis par la navigation depuis la course terminée), et **il n'y a aucun
 * champ de saisie** -- autoriser une saisie ouvrirait la sous-déclaration. Un écart réel (le
 * client n'a pas l'appoint) se traite en remise de caisse (L5-06), pas ici.
 *
 * Après confirmation : nouveau solde, plafond, marge restante et **franchissement du plafond**,
 * tous portés par la réponse de `settle` elle-même (J24, `amoa/questions/L6-14.md`). L'écran
 * n'infère plus rien -- avant, il comparait le solde à un plafond qu'il allait chercher par un
 * second `GET /drivers/me/cash`. Si l'encaissement franchit le plafond, `cashLimitReached` le dit
 * et l'écran propose la remise (L5-07) tout de suite -- plutôt que de laisser le chauffeur
 * découvrir qu'il ne reçoit plus de courses sans savoir pourquoi.
 *
 * Hors connexion : la même clé d'idempotence est réutilisée à chaque nouvelle tentative de CETTE
 * confirmation -- un encaissement rejoué ne produit jamais de double mouvement (Odoo,
 * `babana.idempotency.record`). La file persistante qui survit à un redémarrage de l'app est
 * L6-16 (voir `amoa/questions/L6-14.md`).
 */

type Props = NativeStackScreenProps<DriverParamList, 'Settlement'>;

type Phase = 'idle' | 'confirming' | 'settled' | 'queued' | 'error';

interface CashState {
  balance: number;
  marginRemaining: number;
  cashLimitReached: boolean;
}

export function SettlementScreen({ route, navigation }: Props) {
  const { rideId, amount } = route.params;

  const [phase, setPhase] = useState<Phase>('idle');
  const [cash, setCash] = useState<CashState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Stable pour la vie de l'écran : toutes les tentatives de cette confirmation portent la même
  // clé (critère 5). Une nouvelle confirmation, c'est un nouvel écran, donc une nouvelle clé.
  const idempotencyKeyRef = useRef(generateIdempotencyKey());

  async function handleConfirm() {
    if (phase === 'confirming' || phase === 'settled') return;
    setPhase('confirming');
    setErrorMessage(null);
    try {
      const settled = (await apiClient.request('settleRide', {
        pathParams: { id: rideId },
        body: { amountCollected: amount },
        idempotencyKey: idempotencyKeyRef.current,
      })) as http.SettleRideResponse;

      // Tout vient de la réponse de `settle` (J24) : plus de second appel, plus d'inférence.
      setCash({
        balance: settled.driverCashBalance,
        marginRemaining: settled.marginRemaining,
        cashLimitReached: settled.cashLimitReached,
      });
      setPhase('settled');
    } catch (error) {
      if (error instanceof ApiError) {
        // Erreur métier (SETTLEMENT_AMOUNT_MISMATCH, transition invalide...) : ne se rejoue pas,
        // le message explique.
        setErrorMessage(translateApiError(error));
        setPhase('error');
      } else {
        // Réseau : mis en attente, la clé d'idempotence est conservée pour un renvoi sans risque.
        setPhase('queued');
      }
    }
  }

  const capReached = cash?.cashLimitReached ?? false;

  return (
    <View style={styles.container} testID="settlement-screen">
      <Text style={styles.title}>Encaissement espèces</Text>

      <View style={styles.amountBlock}>
        <Text style={styles.amountLabel}>Montant à encaisser</Text>
        <Text style={styles.amount} testID="settlement-amount">
          {formatMoney(amount)}
        </Text>
        <Text style={styles.amountHint}>Confirmez le montant reçu. Un écart se règle en remise de caisse.</Text>
      </View>

      {phase === 'settled' && cash !== null ? (
        <View style={styles.result} testID="settlement-result">
          <Text style={styles.resultLine} testID="settlement-balance">
            Nouveau solde à remettre : {formatMoney(cash.balance)}
          </Text>
          {!capReached ? (
            <Text style={styles.resultLine} testID="settlement-margin">
              Marge avant plafond : {formatMoney(cash.marginRemaining)}
            </Text>
          ) : null}

          {capReached ? (
            <View style={styles.capBanner} testID="settlement-cap-reached">
              <Text style={styles.capText}>
                Plafond d’encaisse atteint : vous êtes passé hors ligne. Faites une remise pour repartir.
              </Text>
              <Pressable
                testID="settlement-go-to-remittance"
                accessibilityRole="button"
                onPress={() => navigation.navigate('Remittance')}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryLabel}>Déclarer une remise</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              testID="settlement-done"
              accessibilityRole="button"
              onPress={() => replaceWithHome(navigation)}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Terminé</Text>
            </Pressable>
          )}
        </View>
      ) : phase === 'queued' ? (
        <View style={styles.pending} testID="settlement-queued">
          <Text style={styles.pendingText}>
            Encaissement en attente — il sera renvoyé dès que la connexion revient.
          </Text>
          <Pressable testID="settlement-retry" accessibilityRole="button" onPress={handleConfirm} style={styles.primaryButton}>
            <Text style={styles.primaryLabel}>Réessayer maintenant</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {errorMessage ? (
            <Text style={styles.error} testID="settlement-error">
              {errorMessage}
            </Text>
          ) : null}
          <Pressable
            testID="settlement-confirm"
            accessibilityRole="button"
            accessibilityLabel="Confirmer l'encaissement"
            disabled={phase === 'confirming'}
            onPress={handleConfirm}
            style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.primaryLabel}>
              {phase === 'confirming' ? 'Confirmation…' : "Confirmer l'encaissement"}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 20,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  amountBlock: {
    gap: 6,
    alignItems: 'center',
    paddingVertical: 16,
  },
  amountLabel: {
    color: '#6B7280',
  },
  amount: {
    fontSize: 34,
    fontWeight: '800',
  },
  amountHint: {
    color: '#6B7280',
    fontSize: 12,
    textAlign: 'center',
  },
  result: {
    gap: 12,
  },
  resultLine: {
    fontSize: 16,
    color: '#111827',
  },
  capBanner: {
    gap: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 14,
  },
  capText: {
    color: '#92400E',
  },
  pending: {
    gap: 12,
  },
  pendingText: {
    color: '#92400E',
  },
  error: {
    color: '#DC2626',
  },
  primaryButton: {
    minHeight: 64,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A7D3D',
  },
  primaryLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#92400E',
  },
  secondaryLabel: {
    color: '#92400E',
    fontSize: 16,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.85,
  },
});
