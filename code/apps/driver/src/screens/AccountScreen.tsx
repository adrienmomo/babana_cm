import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AccountMenu, Avatar } from '@babana/ui';
import type { http } from '@babana/contracts';
import { apiClient, authClient } from '../auth';
import { APP_NAME } from '../brand';
import { formatDay } from '../format';
import { signOutDriver } from '../signOut';
import { colors } from '../theme';
import { DOCUMENT_LABELS, DOCUMENT_STATUS_LABELS, documentSlots, type DocumentSlot } from './onboarding/state';
import type { DriverParamList } from '../navigation/types';

/**
 * Profil du chauffeur (2 novembre), ouvert par l'avatar en haut à droite de la carte : photo, nom,
 * puis « Ma caisse » et « Mes documents » -- chaque pièce avec son état et, pour le permis, sa date
 * d'expiration, telle qu'Odoo la connaît (`GET /driver/documents`). Le ⋮ de la barre porte la
 * déconnexion, qui passe d'abord hors ligne (`signOut.ts`).
 *
 * Seul un chauffeur `approved` atteint cet écran (`DriverAppSwitch`) : les autres sont dans le
 * parcours de dossier, qui a son propre écran des pièces.
 */
type Props = NativeStackScreenProps<DriverParamList, 'Account'>;

type DocumentsState = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; slots: DocumentSlot[] };

async function signOutFromMenu(): Promise<string | null> {
  const outcome = await signOutDriver();
  return outcome.signedOut ? null : outcome.message;
}

/** Le ⋮ de la barre (`headerRight`) -- hors du composant, pour ne pas recréer le menu à chaque rendu. */
const renderAccountMenu = () => <AccountMenu appName={APP_NAME} onSignOut={signOutFromMenu} />;

export function AccountScreen({ navigation }: Props) {
  const user = authClient.getUser();
  const [documents, setDocuments] = useState<DocumentsState>({ status: 'loading' });

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: renderAccountMenu });
  }, [navigation]);

  const loadDocuments = useCallback(async () => {
    setDocuments({ status: 'loading' });
    try {
      const response = (await apiClient.request('listDriverDocuments')) as http.ListDriverDocumentsResponse;
      setDocuments({ status: 'loaded', slots: documentSlots(response.documents) });
    } catch {
      setDocuments({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <Avatar name={user?.displayName ?? ''} photoUrl={user?.photoUrl ?? null} size={96} testID="account-avatar" />
        <Text style={styles.name}>{user?.displayName ?? ''}</Text>
        <Text style={styles.status}>✓ Compte chauffeur validé</Text>
      </View>

      <View style={styles.list}>
        <Pressable
          testID="account-row-cash"
          accessibilityRole="button"
          onPress={() => navigation.navigate('Cash')}
          style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowLabel}>Ma caisse</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Mes documents</Text>
      <View style={styles.list}>
        {documents.status === 'loading' ? <ActivityIndicator style={styles.loading} /> : null}
        {documents.status === 'error' ? (
          <Pressable testID="account-documents-error" accessibilityRole="button" onPress={loadDocuments} style={styles.row}>
            <Text style={styles.muted}>Documents indisponibles pour le moment. Toucher pour réessayer.</Text>
          </Pressable>
        ) : null}
        {documents.status === 'loaded'
          ? documents.slots.map((slot) => (
              <View key={slot.type} testID={`account-document-${slot.type}`} style={styles.documentRow}>
                <Text style={styles.rowLabel}>{DOCUMENT_LABELS[slot.type]}</Text>
                <Text style={[styles.documentStatus, slot.status === 'rejected' ? styles.rejected : null]}>
                  {slot.expiresOn && slot.status !== 'missing'
                    ? `${DOCUMENT_STATUS_LABELS[slot.status]} · expire le ${formatDay(slot.expiresOn)}`
                    : DOCUMENT_STATUS_LABELS[slot.status]}
                </Text>
                {slot.rejectionReason ? <Text style={styles.rejected}>{slot.rejectionReason}</Text> : null}
              </View>
            ))
          : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  content: { paddingBottom: 32 },
  identity: { alignItems: 'center', gap: 10, paddingTop: 28, paddingBottom: 24, paddingHorizontal: 16 },
  name: { color: colors.ink, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  status: { color: colors.brandText, fontSize: 14 },
  list: { borderTopWidth: 1, borderColor: colors.border },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  pressed: { backgroundColor: colors.canvas },
  rowLabel: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  chevron: { color: colors.subtle, fontSize: 24 },
  sectionTitle: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  documentRow: {
    gap: 4,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  documentStatus: { color: colors.inkSoft, fontSize: 15 },
  rejected: { color: colors.dangerText },
  muted: { color: colors.muted, flexShrink: 1 },
  loading: { paddingVertical: 18 },
});
