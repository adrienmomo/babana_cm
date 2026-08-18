import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ClientParamList } from '../navigation/types';

/**
 * Refus ou expiration (L6-08, D11) : pas d'attribution automatique, retour à la sélection.
 * **Pas d'écran intermédiaire, pas de confirmation à cliquer** (spécification) -- cet écran
 * existe pour porter le message honnête (et le distinguer d'un chauffeur qui ne répond pas), mais
 * il se referme tout seul après un court délai de lecture. Chaque étape ajoutée ici est un
 * abandon supplémentaire (contexte de la spécification) : rien à toucher, rien à confirmer.
 */

type Props = NativeStackScreenProps<ClientParamList, 'DriverRejected'>;

// Ne pas insister avec le même message (critère 3) : deux registres selon le motif -- un chauffeur
// qui refuse et un chauffeur qui ne répond pas ne sont pas la même chose pour le client
// (spécification). Le dernier variant de chaque registre reconnaît explicitement la répétition
// plutôt que de la nier.
const REJECTED_VARIANTS = [
  'Ce chauffeur n’est pas disponible.',
  'Ce chauffeur ne peut pas prendre cette course.',
  'Toujours ce chauffeur-là -- choisissons-en un autre.',
];
const TIMEOUT_VARIANTS = [
  'Ce chauffeur n’a pas répondu à temps.',
  'Toujours pas de réponse de ce chauffeur.',
  'Ce chauffeur reste injoignable -- choisissons-en un autre.',
];

// Le temps de lire le message avant de revenir à la sélection -- assez court pour ne jamais
// ressembler à un écran qu'il faudrait fermer soi-même, assez long pour être lu.
const AUTO_ADVANCE_DELAY_MS = 1800;

export function DriverRejectedScreen({ route, navigation }: Props) {
  const { driverId, reason, selection } = route.params;
  const streak = selection.rejectionStreak + 1;
  const variants = reason === 'driver_timeout' ? TIMEOUT_VARIANTS : REJECTED_VARIANTS;
  const message = variants[Math.min(streak - 1, variants.length - 1)];

  useEffect(() => {
    const timer = setTimeout(() => {
      navigation.replace('Quote', {
        ...selection,
        excludedDriverIds: [...selection.excludedDriverIds, driverId],
        rejectionStreak: streak,
      });
    }, AUTO_ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [navigation, selection, driverId, streak]);

  return (
    <View style={styles.container}>
      <Text style={styles.message} testID="driver-rejected-message">
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    fontSize: 18,
    textAlign: 'center',
    color: '#374151',
  },
});
