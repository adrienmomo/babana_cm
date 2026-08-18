import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { GENERIC_AVATAR, classLabel, distanceLabel, ratingLabel } from './driverFormatting';

/**
 * Ligne de la liste des 5 chauffeurs sur l'écran d'estimation (L6-07, D10, D14) -- une carte
 * entière est la zone de sélection : le client en choisit un en la touchant, pas de bouton
 * séparé à viser sur un écran d'entrée de gamme.
 *
 * Champs identiques à `DriverMarker` (L6-06) -- même charge utile `NearbyDriver`, même mise en
 * forme (`./driverFormatting`) -- mais présentés en ligne plutôt qu'en bandeau horizontal, et
 * sélectionnables.
 */
export interface DriverCardProps {
  driver: http.NearbyDriver;
  onSelect: (driverId: string) => void;
  /** Une sélection est déjà en cours (n'importe laquelle) -- toutes les cartes se désactivent
   * pour empêcher une seconde sélection pendant que la première crée la course (D11 : le client
   * garde la main, mais une seule course à la fois). */
  disabled?: boolean;
}

export function DriverCard({ driver, onSelect, disabled }: DriverCardProps) {
  const gamme = classLabel(driver.motorcycleClass);
  return (
    <Pressable
      testID={`driver-card-${driver.driverId}`}
      accessibilityRole="button"
      accessibilityLabel={`Choisir ${driver.firstName ?? 'ce chauffeur'}`}
      disabled={disabled}
      onPress={() => onSelect(driver.driverId)}
      style={[styles.card, disabled ? styles.cardDisabled : null]}
    >
      <Image source={{ uri: driver.photoUrl ?? GENERIC_AVATAR }} style={styles.avatar} accessibilityIgnoresInvertColors />
      <View style={styles.info}>
        <Text style={styles.name}>{driver.firstName ?? 'Chauffeur'}</Text>
        <Text style={styles.meta}>
          {ratingLabel(driver.rating)}
          {gamme ? ` · ${gamme}` : ''} · {distanceLabel(driver.distanceMeters)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  cardDisabled: {
    opacity: 0.5,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E5E7EB',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    color: '#6B7280',
  },
});
