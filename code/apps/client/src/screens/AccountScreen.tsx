import React, { useLayoutEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AccountMenu, Avatar } from '@babana/ui';
import { authClient, signOut } from '../auth';
import { APP_NAME } from '../brand';
import type { ClientParamList } from '../navigation/types';

/**
 * Profil du client (2 novembre), ouvert par l'avatar en haut à droite de l'accueil : photo, nom,
 * puis la liste de ce qui le concerne -- « Mes courses » (L6-10) y a pris place, et le moyen de
 * paiement est dit. Le ⋮ de la barre porte la déconnexion.
 *
 * Rien n'y est calculé (invariant 3) : le profil est celui de la session (`GET /me`, D35), déjà
 * rafraîchi au démarrage.
 */
type Props = NativeStackScreenProps<ClientParamList, 'Account'>;

async function signOutClient(): Promise<null> {
  await signOut();
  return null;
}

/** Le ⋮ de la barre (`headerRight`) -- hors du composant, pour ne pas recréer le menu à chaque rendu. */
const renderAccountMenu = () => <AccountMenu appName={APP_NAME} onSignOut={signOutClient} />;

export function AccountScreen({ navigation }: Props) {
  const user = authClient.getUser();

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: renderAccountMenu });
  }, [navigation]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.identity}>
        <Avatar name={user?.displayName ?? ''} photoUrl={user?.photoUrl ?? null} size={96} testID="account-avatar" />
        <Text style={styles.name}>{user?.displayName ?? ''}</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { paddingBottom: 32 },
  identity: { alignItems: 'center', gap: 10, paddingTop: 28, paddingBottom: 24, paddingHorizontal: 16 },
  name: { color: '#1F2937', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  verified: { color: '#137347', fontSize: 14 },
  list: { borderTopWidth: 1, borderColor: '#E5E7EB' },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderColor: '#E5E7EB',
  },
  pressed: { backgroundColor: '#F7F8FA' },
  rowLabel: { color: '#1F2937', fontSize: 17, fontWeight: '600' },
  rowValue: { color: '#6B7280', fontSize: 16 },
  chevron: { color: '#9CA3AF', fontSize: 24 },
});
