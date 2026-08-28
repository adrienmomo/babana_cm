import React from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

/**
 * Bouton d'appel du chauffeur (D42, L6-09) : « coordonnées du chauffeur pour l'appeler » pendant
 * l'approche puis la course (spécification, `amoa/questions/L6-09.md`).
 *
 * **Absent, jamais inerte** (même discipline que `ShareTripButton`/`EmergencyButton`,
 * `amoa/specs/L6-mobile.md` §L6-09) : `phoneNumber` est `null` tant que le profil chauffeur n'a
 * pas fini de synchroniser (D30) -- ce composant ne rend rien plutôt qu'un bouton qui échouerait
 * silencieusement à composer un numéro absent.
 */
export interface CallButtonProps {
  phoneNumber: string | null;
}

export function CallButton({ phoneNumber }: CallButtonProps) {
  if (!phoneNumber) return null;

  return (
    <Pressable
      testID="call-button"
      accessibilityRole="button"
      accessibilityLabel="Appeler le chauffeur"
      onPress={() => {
        Linking.openURL(`tel:${phoneNumber}`).catch(() => {
          // Aucun composeur disponible (export web, D22) -- rien de plus à faire ici, le numéro
          // reste lisible dans la carte chauffeur au-dessus de ce bouton.
        });
      }}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <Text style={styles.label}>Appeler</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: '#0A7D3D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
  },
  label: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
});
