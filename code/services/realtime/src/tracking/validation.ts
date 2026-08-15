/**
 * Validation de plausibilité d'une position chauffeur (L3-02). Protège le géo-index (L3-03), pas
 * les données : une position rejetée est écartée, jamais corrigée -- un chauffeur téléporté dans
 * le géo-index serait proposé à un client qu'il ne peut pas rejoindre.
 *
 * Fonction pure, aucun accès Redis ici : `ingest.ts` fournit la position précédente (si elle
 * existe) en paramètre, ce qui rend chaque règle testable individuellement (critère
 * d'acceptation 2) sans dépendre d'un état partagé.
 */

export interface OperationalBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface PlausibilityConfig {
  bounds: OperationalBounds;
  maxAccuracyMeters: number;
  maxTimestampFutureMs: number;
  maxTimestampAgeMs: number;
  maxImpliedSpeedMetersPerSecond: number;
}

export interface PositionSample {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** Horodatage de capture, millisecondes epoch (C-02 : `emittedAt` de l'enveloppe). */
  capturedAtMs: number;
}

export interface PreviousPosition {
  latitude: number;
  longitude: number;
  capturedAtMs: number;
}

export type PlausibilityFailureReason =
  | 'out_of_bounds'
  | 'accuracy_too_low'
  | 'timestamp_in_future'
  | 'timestamp_too_old'
  | 'implied_speed_too_high';

export type PlausibilityResult =
  | { ok: true }
  | { ok: false; reason: PlausibilityFailureReason };

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Distance à vol d'oiseau (Haversine) -- suffisant pour détecter un saut invraisemblable, pas
 * pour calculer un itinéraire (voir É8, services/odoo/.../services/routing.py). */
export function haversineDistanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isWithinBounds(sample: PositionSample, bounds: OperationalBounds): boolean {
  return (
    sample.latitude >= bounds.minLatitude &&
    sample.latitude <= bounds.maxLatitude &&
    sample.longitude >= bounds.minLongitude &&
    sample.longitude <= bounds.maxLongitude
  );
}

/**
 * Vérifie chaque règle de plausibilité, dans un ordre stable. Ne s'arrête pas nécessairement à
 * la première règle testable indépendamment (les tests unitaires isolent chaque règle), mais un
 * seul motif de rejet est retourné -- le premier rencontré dans cet ordre : bornes, coordonnées
 * hors zone, précision, horodatage futur, horodatage trop ancien, vitesse implicite.
 */
export function checkPlausibility(
  sample: PositionSample,
  previous: PreviousPosition | null,
  config: PlausibilityConfig,
  nowMs: number
): PlausibilityResult {
  if (
    Number.isNaN(sample.latitude) ||
    sample.latitude < -90 ||
    sample.latitude > 90 ||
    Number.isNaN(sample.longitude) ||
    sample.longitude < -180 ||
    sample.longitude > 180 ||
    !isWithinBounds(sample, config.bounds)
  ) {
    return { ok: false, reason: 'out_of_bounds' };
  }

  if (sample.accuracyMeters > config.maxAccuracyMeters) {
    return { ok: false, reason: 'accuracy_too_low' };
  }

  if (sample.capturedAtMs - nowMs > config.maxTimestampFutureMs) {
    return { ok: false, reason: 'timestamp_in_future' };
  }

  if (nowMs - sample.capturedAtMs > config.maxTimestampAgeMs) {
    return { ok: false, reason: 'timestamp_too_old' };
  }

  if (previous) {
    const elapsedSeconds = (sample.capturedAtMs - previous.capturedAtMs) / 1000;
    // Un horodatage égal ou antérieur au précédent ne permet pas de calculer une vitesse
    // implicite significative -- pas un rejet en soi (l'horodatage est déjà validé ci-dessus),
    // seulement hors du calcul de vitesse.
    if (elapsedSeconds > 0) {
      const distanceMeters = haversineDistanceMeters(sample, previous);
      const impliedSpeed = distanceMeters / elapsedSeconds;
      if (impliedSpeed > config.maxImpliedSpeedMetersPerSecond) {
        return { ok: false, reason: 'implied_speed_too_high' };
      }
    }
  }

  return { ok: true };
}
