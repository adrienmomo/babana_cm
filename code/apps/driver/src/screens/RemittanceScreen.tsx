import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, generateIdempotencyKey, translateApiError } from '@babana/api-client';
import { Button } from '@babana/ui';
import { declareRemittance } from '../api/cash';
import { formatMoney } from '../format';
import { replaceWithHome } from '../navigation/transitions';
import type { DriverParamList } from '../navigation/types';

/**
 * Déclaration de remise (L5-04, L5-07). Le chauffeur annonce ce qu'il remet -- **le superviseur
 * compte et valide ensuite au back-office** (L5-04, spécification) : cet écran ne fait que
 * poser l'état `declared`, il ne connaît ni le comptage ni la validation.
 *
 * **Hors connexion** (critère 5) : la même clé d'idempotence est réutilisée à chaque tentative de
 * CETTE déclaration -- une déclaration rejouée ne crée jamais une seconde remise (Odoo,
 * `babana.idempotency.record`). Même patron que `SettlementScreen.tsx` : mise en file avec un
 * bouton de nouvelle tentative manuelle, pas encore le remplacement automatique à la reconnexion
 * qu'apporte L6-16.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Remittance'>;

type Phase = 'idle' | 'declaring' | 'declared' | 'queued' | 'error';

export function RemittanceScreen({ navigation }: Props) {
  const [amountText, setAmountText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [declaredAmount, setDeclaredAmount] = useState<number | null>(null);

  const idempotencyKeyRef = useRef(generateIdempotencyKey());

  const parsedAmount = Number.parseInt(amountText, 10);
  const amountIsValid = amountText.trim().length > 0 && Number.isFinite(parsedAmount) && parsedAmount > 0;

  async function handleDeclare() {
    if (!amountIsValid || phase === 'declaring' || phase === 'declared') return;
    setPhase('declaring');
    setErrorMessage(null);
    try {
      const response = await declareRemittance(parsedAmount, idempotencyKeyRef.current);
      setDeclaredAmount(response.amount);
      setPhase('declared');
    } catch (error) {
      if (error instanceof ApiError) {
        setErrorMessage(translateApiError(error));
        setPhase('error');
      } else {
        // Réseau : mis en attente, la clé d'idempotence est conservée pour un renvoi sans risque.
        setPhase('queued');
      }
    }
  }

  return (
    <View style={styles.container} testID="remittance-screen">
      <Text style={styles.title}>Déclarer une remise</Text>
      <Text style={styles.intro}>
        Indiquez le montant que vous remettez. Un superviseur le comptera et validera la remise au
        bureau.
      </Text>

      {phase === 'declared' && declaredAmount !== null ? (
        <View style={styles.result} testID="remittance-declared">
          <Text style={styles.resultLine}>
            Remise déclarée pour {formatMoney(declaredAmount)}.
          </Text>
          <Text style={styles.resultHint}>
            Elle apparaît « en attente » dans votre historique jusqu’à ce qu’un superviseur la
            compte et la valide.
          </Text>
          <Button label="Retour à l'accueil" onPress={() => replaceWithHome(navigation)} testID="remittance-done" />
        </View>
      ) : phase === 'queued' ? (
        <View style={styles.result} testID="remittance-queued">
          <Text style={styles.resultHint}>
            Déclaration en attente — elle sera renvoyée dès que la connexion revient.
          </Text>
          <Button label="Réessayer maintenant" onPress={handleDeclare} testID="remittance-retry" />
        </View>
      ) : (
        <>
          <Text style={styles.label}>Montant remis (FCFA)</Text>
          <TextInput
            testID="remittance-amount-input"
            style={styles.input}
            keyboardType="numeric"
            placeholder="Ex. 8400"
            value={amountText}
            onChangeText={setAmountText}
            editable={phase !== 'declaring'}
          />

          {errorMessage ? (
            <Text style={styles.error} testID="remittance-error">
              {errorMessage}
            </Text>
          ) : null}

          <Pressable
            testID="remittance-submit"
            accessibilityRole="button"
            accessibilityLabel="Déclarer la remise"
            disabled={!amountIsValid || phase === 'declaring'}
            onPress={handleDeclare}
            style={({ pressed }) => [
              styles.primaryButton,
              (!amountIsValid || phase === 'declaring') ? styles.disabled : null,
              pressed && amountIsValid ? styles.pressed : null,
            ]}
          >
            <Text style={styles.primaryLabel}>
              {phase === 'declaring' ? 'Déclaration…' : 'Déclarer'}
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
    gap: 16,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  intro: {
    color: '#4B5563',
  },
  label: {
    color: '#6B7280',
    fontSize: 13,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    minHeight: 56,
    paddingHorizontal: 16,
    fontSize: 20,
  },
  result: {
    gap: 12,
  },
  resultLine: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  resultHint: {
    color: '#6B7280',
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
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
});
