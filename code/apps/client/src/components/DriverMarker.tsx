import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { http } from '@babana/contracts';
import { GENERIC_AVATAR, classLabel, distanceLabel, ratingLabel } from './driverFormatting';

/**
 * Carte d'un chauffeur proche (L6-06), affichée dans la liste sous la carte -- prénom, note ou
 * mention « nouveau », gamme, distance approximative (spécification, critère 5 : jamais une
 * précision supérieure à celle des données déjà arrondies par le serveur, L3-05).
 *
 * `firstName`/`photoUrl`/`rating`/`motorcycleClass` sont nullables (D30, `NearbyDriverSchema`) :
 * un défaut de cache du profil chauffeur dégrade l'affichage, jamais la disponibilité -- ce
 * composant affiche un avatar générique et un libellé neutre plutôt que d'échouer ou de masquer
 * le chauffeur. Mise en forme partagée avec `DriverCard` (L6-07) via `./driverFormatting`.
 */
export interface DriverMarkerProps {
  driver: http.NearbyDriver;
}

export function DriverMarker({ driver }: DriverMarkerProps) {
  const gamme = classLabel(driver.motorcycleClass);
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Image source={{ uri: driver.photoUrl ?? GENERIC_AVATAR }} style={styles.avatar} accessibilityIgnoresInvertColors />
      <Text style={styles.name} numberOfLines={1}>
        {driver.firstName ?? 'Chauffeur'}
      </Text>
      <Text style={styles.meta}>
        {ratingLabel(driver.rating)}
        {gamme ? ` · ${gamme}` : ''}
      </Text>
      <Text style={styles.distance}>{distanceLabel(driver.distanceMeters)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 110,
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E5E7EB',
    marginBottom: 4,
  },
  name: {
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    color: '#374151',
  },
  distance: {
    fontSize: 12,
    color: '#6B7280',
  },
});
