import type { http } from '@babana/contracts';
import type { LatLng } from '@babana/maps';

/**
 * Détection d'arrivée et de départ aux arrêts (L6-21). Le téléphone MESURE, le serveur décide :
 * les seuils viennent de `GET /rides/{id}/stops` (Paramètres > Babana), jamais d'une constante
 * de l'app, et ce qui sort d'ici n'est qu'un événement horodaté que le serveur borne et facture
 * (L4-14, L4-15). Aucune cadence GPS de plus : ce sont les relevés de la capture en course.
 *
 * Pure (pas d'horloge, pas de réseau) : chaque relevé porte son heure.
 */
export interface DetectorFix {
  latitude: number;
  longitude: number;
  /** `null` : inconnue -- déduite alors du relevé précédent. */
  speedMetersPerSecond: number | null;
  atMs: number;
}

/** Ce qu'on attend maintenant : l'arrivée au prochain arrêt, ou le départ du point où l'on est. */
export type DetectorTarget =
  | { kind: 'arrival'; stopId: string; position: LatLng }
  | { kind: 'departure'; stopId: string | null; anchor: LatLng };

export type DetectedEvent =
  | { type: 'arrived'; stopId: string; atMs: number }
  /** `stopId: null` : départ de la prise en charge. `atMs` : DÉBUT du mouvement. */
  | { type: 'departed'; stopId: string | null; atMs: number };

export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function targetKey(target: DetectorTarget): string {
  return target.kind === 'arrival' ? `arrival:${target.stopId}` : `departure:${target.stopId ?? 'pickup'}`;
}

export class StopDetector {
  private key: string | null = null;
  private fired = false;
  private movingSinceMs: number | null = null;
  private previous: DetectorFix | null = null;

  constructor(private config: http.StopDetectionConfig) {}

  setConfig(config: http.StopDetectionConfig): void {
    this.config = config;
  }

  /** Un relevé de plus ; renvoie l'événement à envoyer, au plus un par cible. */
  feed(fix: DetectorFix, target: DetectorTarget | null): DetectedEvent | null {
    const previous = this.previous;
    this.previous = fix;
    if (!target) {
      this.reset(null);
      return null;
    }
    const key = targetKey(target);
    if (key !== this.key) this.reset(key);
    if (this.fired) return null;

    if (target.kind === 'arrival') {
      if (distanceMeters(fix, target.position) <= this.config.arrivalRadiusMeters) {
        this.fired = true;
        return { type: 'arrived', stopId: target.stopId, atMs: fix.atMs };
      }
      return null;
    }

    // La plus grande des deux : la vitesse rapportée, et celle que donnent deux relevés successifs.
    // Android rend 0 -- pas « inconnue » -- pour un relevé sans vitesse (réseau, fusionné) :
    // s'y fier seule laissait une moto qui roule « à l'arrêt » (trouvé sur émulateur, 18 novembre).
    // Le bruit GPS à l'arrêt ne déclenche rien : il faut aussi s'éloigner de la distance minimale.
    const reported = fix.speedMetersPerSecond;
    const implied = impliedSpeed(previous, fix);
    const speed = reported === null && implied === null ? null : Math.max(reported ?? 0, implied ?? 0);
    const threshold = this.config.departureSpeedKmh / 3.6;
    if (speed !== null && speed >= threshold) {
      // Le mouvement commence au premier relevé rapide de la série -- c'est l'heure envoyée.
      this.movingSinceMs ??= fix.atMs;
    } else {
      this.movingSinceMs = null;
      return null;
    }
    const sustained = fix.atMs - this.movingSinceMs >= this.config.departureDurationSeconds * 1000;
    const away = distanceMeters(fix, target.anchor) >= this.config.departureDistanceMeters;
    if (sustained && away) {
      this.fired = true;
      return { type: 'departed', stopId: target.stopId, atMs: this.movingSinceMs };
    }
    return null;
  }

  private reset(key: string | null): void {
    this.key = key;
    this.fired = false;
    this.movingSinceMs = null;
  }
}

function impliedSpeed(previous: DetectorFix | null, fix: DetectorFix): number | null {
  if (!previous || fix.atMs <= previous.atMs) return null;
  return distanceMeters(previous, fix) / ((fix.atMs - previous.atMs) / 1000);
}
