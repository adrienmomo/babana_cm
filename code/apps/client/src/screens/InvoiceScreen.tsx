import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { visibleFareLines } from '../components/fareBreakdown';
import { formatDistance, formatMoney, formatRideDate } from '../format';
import type { ClientParamList } from '../navigation/types';

/**
 * Facture d'une course payée (L6-10, version minimale de démonstration) : la pièce telle qu'émise
 * -- numéro, date, trajet, détail décomposé gelé à la commande, total payé en espèces -- et son
 * renvoi par email. Rien n'est recalculé ici (invariant 3) : tout vient de GET /rides/{id}/invoice.
 */

type Props = NativeStackScreenProps<ClientParamList, 'Invoice'>;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; invoice: http.RideInvoiceResponse };

type SendState = { status: 'idle' } | { status: 'sending' } | { status: 'sent'; email: string } | { status: 'failed'; message: string };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? translateApiError(cause) : fallback;
}

export function InvoiceScreen({ route }: Props) {
  const { rideId } = route.params;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [send, setSend] = useState<SendState>({ status: 'idle' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const invoice = (await apiClient.request('rideInvoice', { pathParams: { id: rideId } })) as http.RideInvoiceResponse;
      setState({ status: 'loaded', invoice });
    } catch (cause) {
      setState({ status: 'error', message: errorMessage(cause, 'Impossible de charger la facture. Réessayez.') });
    }
  }, [rideId]);

  useEffect(() => {
    load();
  }, [load]);

  async function sendByEmail() {
    setSend({ status: 'sending' });
    try {
      const sent = (await apiClient.request('sendInvoiceEmail', { pathParams: { id: rideId } })) as http.SendInvoiceEmailResponse;
      setSend({ status: 'sent', email: sent.email });
    } catch (cause) {
      setSend({ status: 'failed', message: errorMessage(cause, "L'envoi a échoué. Réessayez.") });
    }
  }

  if (state.status === 'loading') {
    return (
      <View style={styles.centered} testID="invoice-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.centered} testID="invoice-error">
        <Text style={styles.error}>{state.message}</Text>
        <Button label="Réessayer" variant="secondary" onPress={load} testID="invoice-retry" />
      </View>
    );
  }

  const { invoice } = state;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="invoice-screen">
      <View style={styles.header}>
        <Text style={styles.number} testID="invoice-number">
          Facture {invoice.invoiceNumber}
        </Text>
        <Text style={styles.meta}>
          Course {invoice.reference} · {formatRideDate(invoice.rideDate)}
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.line}>Départ : {invoice.pickupLabel ?? '—'}</Text>
        <Text style={styles.line}>Arrivée : {invoice.dropoffLabel ?? '—'}</Text>
        {invoice.distanceMeters !== null ? <Text style={styles.meta}>{formatDistance(invoice.distanceMeters)}</Text> : null}
        {invoice.driverName ? <Text style={styles.meta}>Chauffeur : {invoice.driverName}</Text> : null}
      </View>

      <View style={styles.breakdown} testID="invoice-breakdown">
        {visibleFareLines(invoice.breakdown).map((line) => (
          <View style={styles.breakdownRow} key={line.key}>
            <Text style={styles.breakdownLabel}>{line.label}</Text>
            <Text style={styles.breakdownValue}>
              {`${line.subtract ? '-' : ''}${formatMoney(Math.abs(Number(invoice.breakdown[line.key])))}`}
            </Text>
          </View>
        ))}
        <View style={[styles.breakdownRow, styles.totalRow]}>
          <Text style={styles.total}>Total</Text>
          <Text style={styles.total} testID="invoice-total">
            {formatMoney(invoice.amount)}
          </Text>
        </View>
        <Text style={styles.payment}>Payé en espèces au chauffeur</Text>
      </View>

      {invoice.email ? (
        <Button
          testID="invoice-send-email"
          label={send.status === 'sending' ? 'Envoi…' : 'Recevoir par email'}
          variant="secondary"
          onPress={sendByEmail}
          disabled={send.status === 'sending'}
        />
      ) : (
        <Text style={styles.meta} testID="invoice-no-email">
          Aucune adresse email n’est associée à votre compte.
        </Text>
      )}
      {send.status === 'sent' ? (
        <Text style={styles.success} testID="invoice-sent">
          Facture envoyée à {send.email}
        </Text>
      ) : null}
      {send.status === 'failed' ? (
        <Text style={styles.error} testID="invoice-send-error">
          {send.message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  header: { gap: 4 },
  number: { fontSize: 20, fontWeight: '700', color: '#1F2937' },
  meta: { color: '#6B7280' },
  block: { gap: 4 },
  line: { color: '#374151' },
  breakdown: { gap: 4, padding: 16, borderRadius: 12, backgroundColor: '#F9FAFB' },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between' },
  breakdownLabel: { color: '#374151' },
  breakdownValue: { color: '#374151', fontVariant: ['tabular-nums'] },
  totalRow: { marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB' },
  total: { fontSize: 18, fontWeight: '700', color: '#1F2937' },
  payment: { marginTop: 4, color: '#374151', fontWeight: '600' },
  success: { color: '#137347', fontWeight: '600' },
  error: { color: '#B91C1C', textAlign: 'center' },
});
