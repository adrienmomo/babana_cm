import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@babana/ui';
import { DOCUMENT_LABELS, type DocumentSlot, type RequiredDocumentType } from './state';

/**
 * Écran d'attente de validation (L6-15). Il dit **précisément** où en est le dossier -- pas
 * « en cours de validation » tout court, mais l'état de chaque pièce (critère 5), et pour un
 * document rejeté, son motif et un chemin pour le corriger (critère 3). Un chauffeur qui sait ce
 * qu'on attend de lui n'appelle pas et n'abandonne pas.
 */
export interface PendingScreenProps {
  slots: DocumentSlot[];
  /** Ramène à l'écran des documents pour renvoyer ce type précis. */
  onFix: (type: RequiredDocumentType) => void;
  onRefresh: () => Promise<void>;
}

export function PendingScreen({ slots, onFix, onRefresh }: PendingScreenProps) {
  const [refreshing, setRefreshing] = useState(false);
  const needsAction = slots.some((slot) => slot.status === 'rejected' || slot.status === 'missing');

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Dossier en cours de validation</Text>
      <Text style={styles.intro} testID="pending-summary">
        {needsAction
          ? "Une pièce demande votre attention avant que le dossier puisse être validé."
          : "Vos pièces sont déposées. Un gestionnaire les vérifie — vous serez prévenu."}
      </Text>

      {slots.map((slot) => (
        <View key={slot.type} style={styles.row} testID={`pending-row-${slot.type}`}>
          <Text style={styles.rowTitle}>{DOCUMENT_LABELS[slot.type]}</Text>
          <Text style={styles.status} testID={`pending-status-${slot.type}`}>
            {statusLabel(slot)}
          </Text>
          {slot.status === 'rejected' && slot.rejectionReason ? (
            <Text style={styles.reason} testID={`pending-reason-${slot.type}`}>
              Motif : {slot.rejectionReason}
            </Text>
          ) : null}
          {slot.status === 'rejected' || slot.status === 'missing' ? (
            <Button
              label={slot.status === 'missing' ? 'Déposer ce document' : 'Renvoyer ce document'}
              onPress={() => onFix(slot.type)}
              testID={`pending-fix-${slot.type}`}
            />
          ) : null}
        </View>
      ))}

      <Button
        label={refreshing ? 'Actualisation…' : 'Actualiser'}
        onPress={handleRefresh}
        disabled={refreshing}
        variant="secondary"
        testID="pending-refresh"
      />
    </View>
  );
}

function statusLabel(slot: DocumentSlot): string {
  switch (slot.status) {
    case 'missing':
      return 'Pas encore déposé';
    case 'pending':
      return 'En cours de validation';
    case 'verified':
      return 'Validé';
    case 'rejected':
      return 'Refusé';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 16, padding: 24 },
  title: { fontSize: 22, fontWeight: '700' },
  intro: { color: '#4B5563' },
  row: { gap: 6, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  status: { color: '#374151' },
  reason: { color: '#B91C1C' },
});
