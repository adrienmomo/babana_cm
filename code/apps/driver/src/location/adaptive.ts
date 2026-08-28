/**
 * Fréquence adaptative de capture (L6-05, spécification). Fonctions pures, aucune dépendance
 * React Native ici -- testable sans double GPS, même discipline que
 * `services/realtime/src/tracking/validation.ts` côté serveur (fonctions pures, l'appelant
 * fournit l'état).
 */

export type DriverActivityState = 'offline' | 'online_idle' | 'online_moving' | 'in_ride';

export interface AdaptiveCaptureConfig {
  idleIntervalMs: number;
  movingIntervalMs: number;
  rideIntervalMs: number;
  idleSpeedThresholdMps: number;
  idleDisplacementThresholdMeters: number;
  idleDetectionWindowMs: number;
  /** Repli (spécification, "le mode le plus économe") : quand vrai, `online_idle`/`online_moving`
   * ne sont plus distingués -- un seul palier très espacé s'applique aux deux, `degradedIntervalMs`
   * ci-dessous. `in_ride` n'est jamais affecté : on perd la fraîcheur du géo-index hors course, on
   * garde la flotte, jamais l'inverse. */
  degradedMode: boolean;
  degradedIntervalMs: number;
  /** Agrégation avant envoi (spécification, critère 3) : le tampon part dès qu'il atteint cette
   * taille... */
  batchSize: number;
  /** ...ou après ce délai depuis le premier point en attente, même si le tampon n'est pas plein. */
  batchMaxWaitMs: number;
}

/**
 * Intervalle de capture pour l'état donné, en millisecondes -- `null` si aucune capture ne doit
 * avoir lieu (état `offline`, critère d'acceptation 1).
 */
export function captureIntervalFor(state: DriverActivityState, config: AdaptiveCaptureConfig): number | null {
  switch (state) {
    case 'offline':
      return null;
    case 'in_ride':
      return config.rideIntervalMs;
    case 'online_idle':
    case 'online_moving':
      if (config.degradedMode) return config.degradedIntervalMs;
      return state === 'online_idle' ? config.idleIntervalMs : config.movingIntervalMs;
  }
}

interface TimedPoint {
  latitude: number;
  longitude: number;
  atMs: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Même formule que `services/realtime/src/tracking/validation.ts::haversineDistanceMeters` --
 * dupliquée plutôt que partagée : `apps/driver` ne dépend d'aucun paquet de `services/realtime`
 * (frontières vérifiées par le lint, CLAUDE.md), et c'est une poignée de lignes de trigonométrie
 * pure, pas une règle métier qui risquerait de diverger. */
function haversineDistanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Détecte l'immobilité d'un chauffeur en ligne, hors course (spécification : « sur la vitesse et
 * le déplacement cumulé, pas sur un compteur seul »). Deux signaux, jamais un seul :
 *
 * - la vitesse instantanée rapportée par le GPS (fiable en mouvement, bruitée à l'arrêt) ;
 * - le déplacement cumulé sur une fenêtre glissante (fiable à l'arrêt -- une position qui dérive
 *   de quelques mètres de bruit GPS ne franchit jamais le seuil ; un vrai déplacement lent, si,
 *   au bout d'un moment).
 *
 * Mouvement si l'UN OU L'AUTRE l'indique -- immobile seulement si aucun des deux ne l'indique.
 */
export class MovementDetector {
  private readonly points: TimedPoint[] = [];

  constructor(private readonly config: AdaptiveCaptureConfig) {}

  record(position: { latitude: number; longitude: number }, atMs: number): void {
    this.points.push({ ...position, atMs });
    const cutoff = atMs - this.config.idleDetectionWindowMs;
    while (this.points.length > 1 && this.points[0]!.atMs < cutoff) {
      this.points.shift();
    }
  }

  /** `speedMetersPerSecond` vient du GPS (peut être `null`, capteur indisponible ou premier
   * relevé) -- ce détecteur ne le recalcule jamais lui-même, une vitesse dérivée de deux points
   * bruités serait moins fiable que celle du capteur. */
  isMoving(speedMetersPerSecond: number | null): boolean {
    if (speedMetersPerSecond !== null && speedMetersPerSecond >= this.config.idleSpeedThresholdMps) {
      return true;
    }
    if (this.points.length < 2) return false; // pas encore assez d'historique pour juger le déplacement cumulé
    const cumulative = this.cumulativeDisplacementMeters();
    return cumulative >= this.config.idleDisplacementThresholdMeters;
  }

  private cumulativeDisplacementMeters(): number {
    let total = 0;
    for (let i = 1; i < this.points.length; i += 1) {
      total += haversineDistanceMeters(this.points[i - 1]!, this.points[i]!);
    }
    return total;
  }

  reset(): void {
    this.points.length = 0;
  }
}
