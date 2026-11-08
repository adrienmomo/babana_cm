import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Annuler une course en disant pourquoi (demande du 6 novembre ; motifs : L4-07, L4-12) -- les
 * deux apps. Une liste de motifs à toucher, et « Autre » pour écrire le sien : rapide d'un pouce,
 * lisible ensuite au back-office. Générique : les libellés viennent de l'app appelante, et c'est
 * le serveur qui décide si un motif est exigé (le chauffeur) -- `reasonRequired` ne fait que
 * l'annoncer avant l'envoi plutôt qu'après un refus.
 *
 * Le motif envoyé est le libellé choisi, ou le texte saisi après « Autre ». Sans motif (client
 * qui n'en choisit pas) : `null`.
 */

/** Longueur maximale d'un motif -- celle du contrat (`CancelRideRequestSchema`, 280). */
export const CANCEL_REASON_MAX_LENGTH = 280;

export interface CancelRideSheetProps {
  visible: boolean;
  title: string;
  reasons: string[];
  reasonRequired: boolean;
  /** Libellé de l'option qui ouvre le champ libre. */
  otherLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string | null) => void;
  onDismiss: () => void;
  testID?: string;
}

const OTHER = '__other__';

export function CancelRideSheet({
  visible,
  title,
  reasons,
  reasonRequired,
  otherLabel = 'Autre',
  busy = false,
  error = null,
  onConfirm,
  onDismiss,
  testID = 'cancel-sheet',
}: CancelRideSheetProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');

  // Rouvrir la feuille repart de zéro : un motif choisi pour une course ne vaut pas pour la suivante.
  useEffect(() => {
    if (!visible) {
      setSelected(null);
      setOtherText('');
    }
  }, [visible]);

  const reason = selected === OTHER ? otherText.trim() || null : selected;
  const canConfirm = !busy && (!reasonRequired || reason !== null);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID={testID}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{reasonRequired ? 'Pourquoi ? (obligatoire)' : 'Pourquoi ? (facultatif)'}</Text>

          {[...reasons, OTHER].map((option) => {
            const label = option === OTHER ? otherLabel : option;
            const active = selected === option;
            return (
              <Pressable
                key={option}
                testID={option === OTHER ? `${testID}-other` : `${testID}-reason`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
                onPress={() => setSelected(option)}
                style={({ pressed }) => [styles.option, active ? styles.optionActive : null, pressed ? styles.pressed : null]}
              >
                <View style={[styles.radio, active ? styles.radioActive : null]} />
                <Text style={styles.optionLabel}>{label}</Text>
              </Pressable>
            );
          })}

          {selected === OTHER ? (
            <TextInput
              testID={`${testID}-other-text`}
              value={otherText}
              onChangeText={setOtherText}
              placeholder="Précisez…"
              maxLength={CANCEL_REASON_MAX_LENGTH}
              multiline
              autoFocus
              style={styles.input}
            />
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            testID={`${testID}-confirm`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
            disabled={!canConfirm}
            onPress={() => onConfirm(reason)}
            style={({ pressed }) => [styles.confirm, !canConfirm ? styles.disabled : null, pressed ? styles.pressed : null]}
          >
            <Text style={styles.confirmLabel}>{busy ? 'Annulation…' : "Confirmer l'annulation"}</Text>
          </Pressable>
          <Pressable
            testID={`${testID}-dismiss`}
            accessibilityRole="button"
            disabled={busy}
            onPress={onDismiss}
            style={({ pressed }) => [styles.dismiss, pressed ? styles.pressed : null]}
          >
            <Text style={styles.dismissLabel}>Ne pas annuler</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17, 24, 39, 0.45)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 14, color: '#6B7280', marginBottom: 4 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  optionActive: { borderColor: '#B91C1C', backgroundColor: '#FEF2F2' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#9CA3AF' },
  radioActive: { borderColor: '#B91C1C', backgroundColor: '#B91C1C' },
  optionLabel: { fontSize: 16, color: '#1F2937', flexShrink: 1 },
  input: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111827',
    textAlignVertical: 'top',
  },
  error: { color: '#B91C1C', fontSize: 14 },
  confirm: { marginTop: 8, borderRadius: 999, paddingVertical: 16, alignItems: 'center', backgroundColor: '#B91C1C' },
  confirmLabel: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  dismiss: { borderRadius: 999, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' },
  dismissLabel: { color: '#1F2937', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
