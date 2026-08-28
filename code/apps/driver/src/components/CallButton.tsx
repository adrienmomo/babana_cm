import React from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

/**
 * Bouton d'appel du client (D42, L6-13) : « coordonnées du client accessibles pour l'appeler
 * pendant la course » (spécification, referme `amoa/questions/L6-13.md`). Symétrique de
 * `apps/client/src/components/CallButton.tsx`.
 *
 * **Absent, jamais inerte** (même discipline que `EmergencyButton`) : `clientPhoneNumber` est
 * `null` tant que l'enregistrement de proposition n'a pas pu être lu (D30) -- ce composant ne
 * rend rien plutôt qu'un bouton qui échouerait silencieusement à composer un numéro absent.
 */
export interface CallButtonProps {
  clientPhoneNumber: string | null;
}

export function CallButton({ clientPhoneNumber }: CallButtonProps) {
  if (!clientPhoneNumber) return null;

  return (
    <Pressable
      testID="call-client-button"
      accessibilityRole="button"
      accessibilityLabel="Appeler le client"
      onPress={() => {
        Linking.openURL(`tel:${clientPhoneNumber}`).catch(() => {
          // Aucun composeur disponible -- rien de plus à faire ici (même filet que côté Client).
        });
      }}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <Text style={styles.label}>Appeler le client</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
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
    fontSize: 14,
  },
});
