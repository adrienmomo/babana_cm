import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { http } from '@babana/contracts';

/**
 * Carte d'un chauffeur proche (L6-06), affichée dans la liste sous la carte -- prénom, note ou
 * mention « nouveau », gamme, distance approximative (spécification, critère 5 : jamais une
 * précision supérieure à celle des données déjà arrondies par le serveur, L3-05).
 *
 * `firstName`/`photoUrl`/`rating`/`motorcycleClass` sont nullables (D30, `NearbyDriverSchema`) :
 * un défaut de cache du profil chauffeur dégrade l'affichage, jamais la disponibilité -- ce
 * composant affiche un avatar générique et un libellé neutre plutôt que d'échouer ou de masquer
 * le chauffeur.
 */
export interface DriverMarkerProps {
  driver: http.NearbyDriver;
}

const GENERIC_AVATAR = 'https://storage.babana.cm/static/driver-avatar-generic.png';

function distanceLabel(distanceMeters: number): string {
  // Coordonnées de position déjà arrondies à ~11 m (L3-05) -- la distance affichée ne doit pas
  // prétendre à une précision que la donnée n'a pas : au mètre près en dessous de 1 km serait
  // mensonger, on affiche donc par paliers de 50 m ; au-delà, au dixième de km.
  if (distanceMeters < 1000) {
    const rounded = Math.round(distanceMeters / 50) * 50;
    return `${rounded} m`;
  }
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function ratingLabel(rating: number | null): string {
  // « Nouveau » plutôt qu'une note quand elle manque (L4-09, spécification L6-07) -- un chauffeur
  // sans avis suffisants n'a pas de note à afficher, pas une note de zéro.
  return rating === null ? 'Nouveau' : `${rating.toFixed(1)} ★`;
}

function classLabel(motorcycleClass: http.NearbyDriver['motorcycleClass']): string | null {
  if (motorcycleClass === null) return null;
  return motorcycleClass === 'premium' ? 'Confort' : 'Standard';
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
