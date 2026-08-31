import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Button } from '@babana/ui';

/**
 * Première étape de l'inscription chauffeur (L6-15) : le chauffeur confirme l'identité issue de
 * sa connexion Google avant de déposer ses pièces. Rien d'autre n'est demandé ici -- le nom
 * légal et la pièce d'identité sont vérifiés à l'étape suivante, et le numéro de téléphone
 * relève de L1-09 (voir `amoa/questions/L6-15.md`).
 *
 * `onContinue` marque le profil confirmé (persisté, critère 1 -- reprenable) puis fait avancer
 * vers l'écran des documents ; le conteneur (`navigation/index.tsx`) fournit les deux gestes.
 */
export interface ProfileScreenProps {
  user: { displayName: string; photoUrl: string | null };
  onContinue: () => Promise<void> | void;
}

export function ProfileScreen({ user, onContinue }: ProfileScreenProps) {
  const [busy, setBusy] = useState(false);

  async function handleContinue() {
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Votre inscription</Text>
      <Text style={styles.intro}>
        Vérifiez vos informations, puis déposez votre permis et votre pièce d'identité. Un
        gestionnaire validera votre dossier.
      </Text>

      {user.photoUrl ? (
        <Image source={{ uri: user.photoUrl }} style={styles.avatar} testID="profile-avatar" />
      ) : null}
      <Text style={styles.name} testID="profile-name">
        {user.displayName || 'Compte sans nom'}
      </Text>

      <Button
        label={busy ? 'Un instant…' : 'Continuer'}
        onPress={handleContinue}
        disabled={busy}
        testID="profile-continue"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  title: { fontSize: 22, fontWeight: '700' },
  intro: { textAlign: 'center', color: '#4B5563' },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  name: { fontSize: 18, fontWeight: '600' },
});
