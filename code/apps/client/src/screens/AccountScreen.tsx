import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AccountMenu, Avatar, ThemePicker, formatRatingSummary, makeStyles } from '@babana/ui';
import { apiClient, authClient, signOut } from '../auth';
import { APP_NAME } from '../brand';
import type { ClientParamList } from '../navigation/types';

/**
 * Profil du client (2 novembre), ouvert par l'avatar en haut à droite de l'accueil : photo, nom,
 * la note reçue de ses chauffeurs, puis la liste de ce qui le concerne -- « Mes courses » (L6-10) y a pris place, et le moyen de
 * paiement est dit. Le ⋮ de la barre porte la déconnexion.
 *
 * Rien n'y est calculé (invariant 3) : le profil, note comprise, est celui de `GET /me` (D35).
 */
type Props = NativeStackScreenProps<ClientParamList, 'Account'>;

async function signOutClient(): Promise<null> {
  await signOut();
  return null;
}

/** Le ⋮ de la barre (`headerRight`) -- hors du composant, pour ne pas recréer le menu à chaque rendu. */
const renderAccountMenu = () => <AccountMenu appName={APP_NAME} onSignOut={signOutClient} />;

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

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: renderAccountMenu });
  }, [navigation]);

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
        {user?.phoneVerified ? <Text style={styles.verified}>✓ Numéro de téléphone vérifié</Text> : null}
      </View>

      <View style={styles.list}>
        <Pressable
          testID="account-row-history"
          accessibilityRole="button"
          onPress={() => navigation.navigate('History')}
          style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowLabel}>Mes courses</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <View style={styles.row} testID="account-row-payment">
          <Text style={styles.rowLabel}>Paiement</Text>
          <Text style={styles.rowValue}>Espèces</Text>
        </View>
      </View>

      {/* 15 novembre : clair, sombre, noir ou celui du téléphone -- gardé sur ce téléphone. */}
      <View style={styles.appearance}>
        <ThemePicker />
      </View>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  appearance: {
    marginTop: 24,
    paddingHorizontal: 20,
  },
  container: { flex: 1, backgroundColor: c.surface },
  content: { paddingBottom: 32 },
  identity: { alignItems: 'center', gap: 10, paddingTop: 28, paddingBottom: 24, paddingHorizontal: 16 },
  name: { color: c.ink, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  rating: { color: c.ink, fontSize: 16, fontWeight: '600' },
  verified: { color: c.brandText, fontSize: 14 },
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
  rowValue: { color: c.muted, fontSize: 16 },
  chevron: { color: c.subtle, fontSize: 24 },
}));
