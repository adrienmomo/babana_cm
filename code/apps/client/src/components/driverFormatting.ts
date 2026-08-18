import type { http } from '@babana/contracts';

/**
 * Mise en forme partagée entre `DriverMarker` (L6-06, bandeau de l'accueil) et `DriverCard`
 * (L6-07, liste de sélection) -- un seul chauffeur affiché de deux façons différentes ne doit
 * pas recalculer deux fois la même règle d'affichage.
 */

export const GENERIC_AVATAR = 'https://storage.babana.cm/static/driver-avatar-generic.png';

export function distanceLabel(distanceMeters: number): string {
  // Coordonnées de position déjà arrondies à ~11 m (L3-05) -- la distance affichée ne doit pas
  // prétendre à une précision que la donnée n'a pas : au mètre près en dessous de 1 km serait
  // mensonger, on affiche donc par paliers de 50 m ; au-delà, au dixième de km.
  if (distanceMeters < 1000) {
    const rounded = Math.round(distanceMeters / 50) * 50;
    return `${rounded} m`;
  }
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

export function ratingLabel(rating: number | null): string {
  // « Nouveau » plutôt qu'une note quand elle manque (L4-09, spécification L6-07) -- un chauffeur
  // sans avis suffisants n'a pas de note à afficher, pas une note de zéro.
  return rating === null ? 'Nouveau' : `${rating.toFixed(1)} ★`;
}

export function classLabel(motorcycleClass: http.NearbyDriver['motorcycleClass']): string | null {
  if (motorcycleClass === null) return null;
  return motorcycleClass === 'premium' ? 'Confort' : 'Standard';
}
