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

/**
 * Distance (m) de `position` au tracé `points` -- au segment le plus proche, pas seulement aux
 * sommets. Projection plane locale (équirectangulaire) : exacte à quelques mètres près à l'échelle
 * d'une ville, ce qui suffit pour décider si le chauffeur a quitté son itinéraire.
 */
export function distanceToRouteMeters(position: LatLng, points: LatLng[]): number {
  if (points.length === 0) return Infinity;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad(position.latitude));
  const project = (p: LatLng) => ({
    x: toRad(p.longitude - position.longitude) * cosLat * EARTH_RADIUS_METERS,
    y: toRad(p.latitude - position.latitude) * EARTH_RADIUS_METERS,
  });
  if (points.length === 1) return distanceMeters(position, points[0] as LatLng);

  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = project(points[i] as LatLng);
    const b = project(points[i + 1] as LatLng);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    // Le chauffeur est à l'origine de la projection.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

/**
 * Part du tracé qui reste à parcourir depuis `position` (0 à 1), mesurée depuis le point du tracé
 * le plus proche. Sert à afficher la distance et la durée restantes entre deux calculs
 * d'itinéraire : le tracé n'est recalculé qu'en cas d'écart ou de vieillissement, et sa longueur
 * initiale restait affichée jusqu'au client (« 0.7 km » une fois arrivé, 30 octobre). Un affichage,
 * pas une règle : le tarif ne lit jamais ceci. Tracé dégénéré : 1, faute de mieux.
 */
export function remainingRouteFraction(position: LatLng, points: LatLng[]): number {
  if (points.length < 2) return 1;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosLat = Math.cos(toRad(position.latitude));
  const project = (p: LatLng) => ({
    x: toRad(p.longitude - position.longitude) * cosLat * EARTH_RADIUS_METERS,
    y: toRad(p.latitude - position.latitude) * EARTH_RADIUS_METERS,
  });

  const lengths: number[] = [];
  let best = { distance: Infinity, segment: 0, t: 0 };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = project(points[i] as LatLng);
    const b = project(points[i + 1] as LatLng);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    lengths.push(Math.sqrt(lengthSquared));
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    const distance = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (distance < best.distance) best = { distance, segment: i, t };
  }
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return 1;
  let remaining = (1 - best.t) * (lengths[best.segment] as number);
  for (let i = best.segment + 1; i < lengths.length; i += 1) remaining += lengths[i] as number;
  return Math.max(0, Math.min(1, remaining / total));
}
