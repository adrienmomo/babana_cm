import type { LatLng } from '@babana/maps';

/**
 * Assemblage du corps de `POST /rides/{id}/complete` (L6-13).
 *
 * **ÉCART, voir `amoa/questions/L6-13.md`.** Le contrat exige `{ distanceMeters, durationSeconds,
 * polyline }` -- un relevé du trajet réellement parcouru. L'app Chauffeur n'en a aucune source :
 * L6-05 (capture GPS) et L3-10 (accumulation côté service) ne sont pas construites, et L4-04 dit
 * que c'est le service temps réel qui doit fournir ces valeurs, pas l'app. En attendant
 * l'arbitrage, l'app envoie ce qu'elle détient honnêtement :
 *
 * - `durationSeconds` : mesuré depuis le démarrage observé (une horloge, pas une supposition) ;
 * - `distanceMeters` : la distance de référence de la course (celle qui a servi au tarif). Le
 *   montant final se calcule de toute façon sur elle (L4-04, `_babana_compute_final_amount`),
 *   jamais sur cette valeur ; et `actual ≈ référence` n'arme pas l'alerte d'écart (L4-04, crit 3) ;
 * - `polyline` : la ligne droite départ -> arrivée, faute d'avoir relevé le trajet réel.
 */

const NORMALIZATION_FACTOR = 1e5;

/** Encodage polyline Google (algorithme standard, opérations sur les bits inhérentes). Utilisé
 * ici pour un tracé à deux points. */
/* eslint-disable no-bitwise */
export function encodePolyline(points: LatLng[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';

  const encodeSigned = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  };

  for (const point of points) {
    const lat = Math.round(point.latitude * NORMALIZATION_FACTOR);
    const lng = Math.round(point.longitude * NORMALIZATION_FACTOR);
    result += encodeSigned(lat - lastLat) + encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return result;
}
/* eslint-enable no-bitwise */

export interface CompletionBody {
  distanceMeters: number;
  durationSeconds: number;
  polyline: string;
}

export function buildCompletionBody(input: {
  referenceDistanceMeters: number;
  startedAtMs: number;
  origin: LatLng;
  destination: LatLng;
  now?: number;
}): CompletionBody {
  const elapsedMs = Math.max(0, (input.now ?? Date.now()) - input.startedAtMs);
  return {
    distanceMeters: Math.max(0, Math.round(input.referenceDistanceMeters)),
    durationSeconds: Math.round(elapsedMs / 1000),
    polyline: encodePolyline([input.origin, input.destination]),
  };
}
