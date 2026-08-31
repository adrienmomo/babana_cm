import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@babana/ui';
import { ApiError, translateApiError, type DriverDocumentUploader } from '@babana/api-client';
import {
  DOCUMENT_LABELS,
  allDocumentsSubmitted,
  type DocumentSlot,
  type PendingUpload,
  type RequiredDocumentType,
} from './state';
import type { ImageSource } from './imageSource';

/**
 * Dépôt des pièces (L6-15). Une ligne par document requis (permis, pièce d'identité -- jamais de
 * carte grise, É2, critère 4). Pour chaque ligne :
 *
 * - **Reprise possible** : l'état affiché vient du serveur (`slots`), pas d'un suivi local.
 * - **Compression avant envoi** (critère 2) : `imageSource.pick` compresse sous `maxBytes` ;
 *   une image encore trop lourde est refusée, jamais envoyée.
 * - **Survit à une coupure** (spécification) : la photo prise est persistée (`onSavePending`)
 *   AVANT l'envoi. Un échec réseau laisse un bouton « Réessayer l'envoi » qui rejoue le MÊME
 *   fichier -- le chauffeur ne reprend pas la photo.
 * - **Renvoi d'un seul document** (critère 3) : chaque ligne est indépendante ; un rejet
 *   n'affecte que sa ligne.
 */
export interface DocumentsScreenProps {
  slots: DocumentSlot[];
  pendingUploads: Partial<Record<RequiredDocumentType, PendingUpload>>;
  imageSource: ImageSource;
  uploader: DriverDocumentUploader;
  maxBytes: number;
  /** Un type à mettre en avant (arrive depuis l'écran d'attente, « Renvoyer ce document »). */
  focusType?: RequiredDocumentType;
  onSavePending: (upload: PendingUpload) => Promise<void>;
  onClearPending: (type: RequiredDocumentType) => Promise<void>;
  /** Relit l'état serveur -- appelé après chaque envoi réussi. */
  onRefresh: () => Promise<void>;
  /** Tous les documents déposés (pending ou verified) -- fait avancer vers l'écran d'attente. */
  onAllSubmitted: () => void;
}

export function DocumentsScreen({
  slots,
  pendingUploads,
  imageSource,
  uploader,
  maxBytes,
  focusType,
  onSavePending,
  onClearPending,
  onRefresh,
  onAllSubmitted,
}: DocumentsScreenProps) {
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!submittedRef.current && slots.length > 0 && allDocumentsSubmitted(slots)) {
      submittedRef.current = true;
      onAllSubmitted();
    }
  }, [slots, onAllSubmitted]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Vos documents</Text>
      <Text style={styles.intro}>
        Prenez une photo nette de chaque pièce. Elles ne sont jamais partagées publiquement.
      </Text>

      {slots.map((slot) => (
        <DocumentRow
          key={slot.type}
          slot={slot}
          highlighted={slot.type === focusType}
          pending={pendingUploads[slot.type]}
          imageSource={imageSource}
          uploader={uploader}
          maxBytes={maxBytes}
          onSavePending={onSavePending}
          onClearPending={onClearPending}
          onRefresh={onRefresh}
        />
      ))}
    </View>
  );
}

interface DocumentRowProps {
  slot: DocumentSlot;
  highlighted: boolean;
  pending: PendingUpload | undefined;
  imageSource: ImageSource;
  uploader: DriverDocumentUploader;
  maxBytes: number;
  onSavePending: (upload: PendingUpload) => Promise<void>;
  onClearPending: (type: RequiredDocumentType) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function DocumentRow({
  slot,
  highlighted,
  pending,
  imageSource,
  uploader,
  maxBytes,
  onSavePending,
  onClearPending,
  onRefresh,
}: DocumentRowProps) {
  const { type } = slot;
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un envoi interrompu : le fichier est en attente localement, un bouton le rejoue tel quel.
  const [interrupted, setInterrupted] = useState(false);

  async function send(upload: PendingUpload) {
    try {
      await uploader.upload({
        documentType: type,
        file: { uri: upload.uri, name: upload.name, mimeType: upload.mimeType },
        expiresOn: upload.expiresOn,
      });
      await onClearPending(type);
      setInterrupted(false);
      await onRefresh();
    } catch (cause) {
      if (cause instanceof ApiError) {
        // Erreur métier (type MIME, validation) : le fichier ne passera jamais -- on l'oublie,
        // le chauffeur reprend une photo.
        await onClearPending(type);
        setInterrupted(false);
        setError(translateApiError(cause));
      } else {
        // Réseau : on garde le fichier, réessai possible sans reprendre la photo.
        setInterrupted(true);
        setError("L'envoi a été interrompu. Réessayez, votre photo est conservée.");
      }
    }
  }

  async function pick(source: 'camera' | 'gallery') {
    setError(null);
    if (type === 'license' && !ISO_DATE.test(expiresOn)) {
      setError("Indiquez la date d'expiration du permis (AAAA-MM-JJ).");
      return;
    }
    setBusy(true);
    try {
      const picked = await imageSource.pick({ source, maxBytes });
      if (!picked) return; // annulé
      if (picked.sizeBytes > maxBytes) {
        setError('La photo est encore trop lourde. Reprenez-la de plus loin.');
        return;
      }
      const upload: PendingUpload = {
        type,
        uri: picked.uri,
        name: picked.name,
        mimeType: picked.mimeType,
        ...(type === 'license' ? { expiresOn } : {}),
      };
      await onSavePending(upload);
      await send(upload);
    } catch {
      setError("La prise de photo a échoué. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!pending) return;
    setError(null);
    setBusy(true);
    try {
      await send(pending);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, highlighted ? styles.rowHighlighted : null]} testID={`doc-row-${type}`}>
      <Text style={styles.rowTitle}>{DOCUMENT_LABELS[type]}</Text>
      <Text style={styles.status} testID={`doc-status-${type}`}>
        {statusLabel(slot)}
      </Text>
      {slot.status === 'rejected' && slot.rejectionReason ? (
        <Text style={styles.reason} testID={`doc-reason-${type}`}>
          Motif : {slot.rejectionReason}
        </Text>
      ) : null}

      {type === 'license' ? (
        <TextInput
          testID="doc-license-expiry"
          style={styles.input}
          placeholder="Date d'expiration (AAAA-MM-JJ)"
          autoCapitalize="none"
          value={expiresOn}
          onChangeText={setExpiresOn}
        />
      ) : null}

      {error ? (
        <Text style={styles.error} testID={`doc-error-${type}`}>
          {error}
        </Text>
      ) : null}

      {interrupted && pending ? (
        <Button label="Réessayer l'envoi" onPress={retry} disabled={busy} testID={`doc-retry-${type}`} />
      ) : (
        <View style={styles.actions}>
          <Button
            label="Prendre une photo"
            onPress={() => pick('camera')}
            disabled={busy}
            testID={`doc-camera-${type}`}
          />
          <Button
            label="Galerie"
            onPress={() => pick('gallery')}
            disabled={busy}
            variant="secondary"
            testID={`doc-gallery-${type}`}
          />
        </View>
      )}
    </View>
  );
}

function statusLabel(slot: DocumentSlot): string {
  switch (slot.status) {
    case 'missing':
      return 'À déposer';
    case 'pending':
      return 'En cours de validation';
    case 'verified':
      return 'Validé';
    case 'rejected':
      return 'Refusé — à renvoyer';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 16, padding: 24 },
  title: { fontSize: 22, fontWeight: '700' },
  intro: { color: '#4B5563' },
  row: { gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  rowHighlighted: { borderColor: '#0A7D3D', borderWidth: 2 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  status: { color: '#374151' },
  reason: { color: '#B91C1C' },
  input: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 6, padding: 8 },
  error: { color: '#B91C1C' },
  actions: { flexDirection: 'row', gap: 8 },
});
