import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@babana/ui';

/**
 * Dossier refusé globalement (amoa/questions/REPONSES-2026-09-04.md §2) : `driverStatus`
 * 'rejected' (candidature écartée par un gestionnaire) ou 'suspended' (compte suspendu). C'est
 * la troisième des trois situations qui n'appellent pas la même action -- pas « en cours de
 * validation » (PendingScreen, rien à faire qu'attendre), pas « il manque telle pièce »
 * (DocumentsScreen), mais **le motif**, et le chemin pour corriger et resoumettre.
 *
 * Sans cet écran, un chauffeur refusé était routé comme un `pending` : il redéposait des pièces
 * qui seraient refusées de nouveau, sans jamais savoir pourquoi.
 */
export interface RejectedScreenProps {
  status: 'rejected' | 'suspended';
  /** `AuthenticatedUser.driverRejectionReason` -- `null` si le gestionnaire n'en a pas laissé
   * (ne devrait pas arriver, le motif est obligatoire côté Odoo, L1-06 critère 3). */
  reason: string | null;
  /** Ramène à l'écran de dépôt des pièces pour corriger et resoumettre. */
  onResubmit: () => void;
}

export function RejectedScreen({ status, reason, onResubmit }: RejectedScreenProps) {
  const [busy, setBusy] = useState(false);
  // Garde synchrone : deux appuis rapprochés (avant le re-rendu qui désactive le bouton) ne
  // doivent pas naviguer deux fois vers l'écran des documents.
  const triggered = useRef(false);

  function handleResubmit() {
    if (triggered.current) return;
    triggered.current = true;
    setBusy(true);
    onResubmit();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} testID="rejected-title">
        {status === 'suspended' ? 'Votre compte est suspendu' : "Votre dossier n'a pas été retenu"}
      </Text>

      <View style={styles.reasonBox}>
        <Text style={styles.reasonLabel}>Motif</Text>
        <Text style={styles.reason} testID="rejected-reason">
          {reason && reason.trim()
            ? reason
            : "Aucun motif n'a été communiqué. Contactez le support pour en savoir plus."}
        </Text>
      </View>

      <Text style={styles.help} testID="rejected-help">
        {status === 'suspended'
          ? 'Corrigez ce qui est signalé, renvoyez les pièces concernées, puis attendez un nouvel examen.'
          : 'Vous pouvez corriger les pièces concernées et les renvoyer pour un nouvel examen.'}
      </Text>

      <Button
        label={busy ? 'Un instant…' : 'Corriger et renvoyer mes pièces'}
        onPress={handleResubmit}
        disabled={busy}
        testID="rejected-resubmit"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 16, padding: 24, justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '700' },
  reasonBox: { gap: 6, padding: 16, borderRadius: 8, borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  reasonLabel: { fontSize: 12, fontWeight: '700', color: '#B91C1C', textTransform: 'uppercase' },
  reason: { color: '#7F1D1D', fontSize: 16 },
  help: { color: '#4B5563' },
});
