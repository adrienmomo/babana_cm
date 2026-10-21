import type { LatLng } from '@babana/maps';

const EARTH_RADIUS_METERS = 6_371_000;

/** Distance à vol d'oiseau (haversine), en mètres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Le chauffeur est-il assez près du point pour s'y déclarer « Sur place » ? Faux sans position :
 * le bouton n'apparaît jamais sur une position inconnue. Le rayon vient de la configuration
 * (`ARRIVAL_RADIUS_METERS`, invariant 5) -- c'est un confort d'affichage, pas une règle métier :
 * le serveur ne conditionne rien à cette proximité.
 */
export function isWithinRadius(position: LatLng | null, target: LatLng, radiusMeters: number): boolean {
  if (!position) return false;
  return distanceMeters(position, target) <= radiusMeters;
}
