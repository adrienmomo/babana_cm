import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AccountMenu, Avatar, ThemePicker, formatRatingSummary } from '@babana/ui';
import type { http } from '@babana/contracts';
import { apiClient, authClient } from '../auth';
import { APP_NAME } from '../brand';
import { formatDay } from '../format';
import { signOutDriver } from '../signOut';
import { makeStyles } from '../theme';
import { DOCUMENT_LABELS, DOCUMENT_STATUS_LABELS, documentSlots, type DocumentSlot } from './onboarding/state';
import { defaultImageSource } from './onboarding/imageSource';
import { documentUploader } from '../onboarding';
import { ONBOARDING_MAX_DOCUMENT_BYTES } from '../../config';
import type { DriverParamList } from '../navigation/types';

/**
 * Profil du chauffeur (2 novembre), ouvert par l'avatar en haut à droite de la carte : photo, nom,
 * sa note reçue des clients, puis « Ma priorité » (19 novembre), « Ma caisse », « Mes courses » (où il corrige les notes données
 * à ses clients) et « Mes documents » -- chaque pièce avec son état et, pour le permis, sa date
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
  const styles = useStyles();
  const [user, setUser] = useState(() => authClient.getUser());

  // La session date du démarrage de l'app ; la note, elle, bouge après chaque course. Relue à
  // l'ouverture du profil -- hors connexion, celle de la session reste affichée.
  useEffect(() => {
    let cancelled = false;
    authClient.refreshUser(apiClient).then(
      (state) => {
        if (!cancelled) setUser(state.user);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);
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

  // 15 novembre : un chauffeur approuvé avant que la photo de profil ne soit requise la dépose
  // ici ; tout chauffeur la change ici. Appareil photo avant ; la nouvelle photo attend sa
  // validation au back-office, l'ancienne reste celle que voient les clients jusque-là.
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const takeProfilePhoto = useCallback(async () => {
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      const picked = await defaultImageSource.pick({ source: 'camera', cameraFacing: 'front', maxBytes: ONBOARDING_MAX_DOCUMENT_BYTES });
      if (!picked) return;
      if (picked.sizeBytes > ONBOARDING_MAX_DOCUMENT_BYTES) {
        setPhotoError('La photo est trop lourde. Reprenez-la.');
        return;
      }
      await documentUploader.upload({ documentType: 'profile_photo', file: { uri: picked.uri, name: picked.name, mimeType: picked.mimeType } });
      await loadDocuments();
    } catch {
      setPhotoError("La photo n'a pas pu être envoyée. Réessayez.");
    } finally {
      setPhotoBusy(false);
    }
  }, [loadDocuments]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <Avatar name={user?.displayName ?? ''} photoUrl={user?.photoUrl ?? null} size={96} testID="account-avatar" />
        <Text style={styles.name}>{user?.displayName ?? ''}</Text>
        {user ? (
          <Text testID="account-rating" style={styles.rating}>
            {formatRatingSummary(user.rating)}
          </Text>
        ) : null}
        <Text style={styles.status}>✓ Compte chauffeur validé</Text>
      </View>

      <View style={styles.list}>
        {user?.driverPriority ? (
          <Pressable
            testID="account-row-priority"
            accessibilityRole="button"
            onPress={() => navigation.navigate('Priority')}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
          >
            <Text style={styles.rowLabel}>Priorité</Text>
            <View style={styles.rowEnd}>
              <Text testID="account-priority-value" style={styles.rowValue}>
                {`${user.driverPriority.total}/${user.driverPriority.max}`}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Pressable>
        ) : null}
        <Pressable
          testID="account-row-cash"
          accessibilityRole="button"
          onPress={() => navigation.navigate('Cash')}
          style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowLabel}>Ma caisse</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <Pressable
          testID="account-row-history"
          accessibilityRole="button"
          onPress={() => navigation.navigate('RideHistory')}
          style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowLabel}>Mes courses</Text>
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
                {slot.type === 'profile_photo' ? (
                  <Pressable
                    testID="account-profile-photo"
                    accessibilityRole="button"
                    disabled={photoBusy}
                    onPress={takeProfilePhoto}
                    style={styles.photoButton}
                  >
                    {photoBusy ? (
                      <ActivityIndicator />
                    ) : (
                      <Text style={styles.photoButtonLabel}>{slot.status === 'missing' ? 'Ajouter ma photo' : 'Changer ma photo'}</Text>
                    )}
                  </Pressable>
                ) : null}
                {slot.type === 'profile_photo' && photoError ? (
                  <Text testID="account-profile-photo-error" style={styles.rejected}>
                    {photoError}
                  </Text>
                ) : null}
              </View>
            ))
          : null}
      </View>

      {/* 15 novembre : clair, sombre, noir ou celui du téléphone -- gardé sur ce téléphone. */}
      <View style={styles.appearance}>
        <ThemePicker />
      </View>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  content: { paddingBottom: 32 },
  identity: { alignItems: 'center', gap: 10, paddingTop: 28, paddingBottom: 24, paddingHorizontal: 16 },
  name: { color: c.ink, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  rating: { color: c.ink, fontSize: 16, fontWeight: '600' },
  status: { color: c.brandText, fontSize: 14 },
  list: { borderTopWidth: 1, borderColor: c.border },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  pressed: { backgroundColor: c.canvas },
  rowLabel: { color: c.ink, fontSize: 17, fontWeight: '600' },
  chevron: { color: c.subtle, fontSize: 24 },
  rowEnd: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowValue: { color: c.ink, fontSize: 17, fontWeight: '700' },
  photoButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.brandBorder,
    backgroundColor: c.brandSoft,
    justifyContent: 'center',
  },
  photoButtonLabel: {
    color: c.brandText,
    fontWeight: '600',
  },
  appearance: {
    marginTop: 24,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    color: c.muted,
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
    borderColor: c.border,
  },
  documentStatus: { color: c.inkSoft, fontSize: 15 },
  rejected: { color: c.dangerText },
  muted: { color: c.muted, flexShrink: 1 },
  loading: { paddingVertical: 18 },
}));
