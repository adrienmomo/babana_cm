import { useEffect, useRef, useState } from 'react';
import type { LatLng } from './types';

/**
 * Glissement d'une moto entre deux positions (14 novembre) : la moto avance au lieu de sauter.
 * Même règle pour tous les fournisseurs -- ce module pour la carte Google native et le web, sa
 * copie dans la page Leaflet (`providers/osm/leafletHtml.ts`, qui reprend ces constantes : le code
 * d'une page WebView ne peut pas importer un module).
 *
 * Durée = temps écoulé depuis la position précédente, borné : la moto arrive à peu près quand la
 * suivante tombe, le mouvement paraît continu à 3 s de cadence. Au-delà de GLIDE_JUMP_DEG
 * (~500 m, une reprise après coupure), elle saute : la faire traverser la ville en glissant
 * mentirait sur son trajet. Affichage seulement, aucune donnée métier.
 */
export const GLIDE_MIN_MS = 300;
export const GLIDE_MAX_MS = 4_000;
export const GLIDE_JUMP_DEG = 0.005;
/** Cadence de rafraîchissement du repère pendant un glissement : ~20 images/s suffisent à l'œil et
 * ménagent un terminal d'entrée de gamme (chaque image redessine le repère natif). */
export const GLIDE_FRAME_MS = 50;

/** Durée du glissement de `from` à `to` ; 0 : saut (première position, ou trop loin). */
export function glideDurationMs(from: LatLng, to: LatLng, previousAtMs: number | null, nowMs: number): number {
  if (previousAtMs === null) return 0;
  const far = Math.abs(from.latitude - to.latitude) > GLIDE_JUMP_DEG || Math.abs(from.longitude - to.longitude) > GLIDE_JUMP_DEG;
  if (far) return 0;
  return Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, nowMs - previousAtMs));
}

/** Position à l'instant `nowMs` d'un glissement linéaire commencé à `startMs`. */
export function glidePosition(from: LatLng, to: LatLng, startMs: number, durationMs: number, nowMs: number): LatLng {
  if (durationMs <= 0) return to;
  const t = Math.min(1, Math.max(0, (nowMs - startMs) / durationMs));
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * t,
    longitude: from.longitude + (to.longitude - from.longitude) * t,
  };
}

/**
 * Position affichée d'un repère qui glisse vers `target`. `enabled` à false (épingles, client) :
 * la cible telle quelle, sans minuteur. Une nouvelle cible repart de la position affichée, jamais
 * de l'ancienne cible : la moto ne recule pas.
 */
export function useGlidingPosition(target: LatLng, enabled: boolean, now: () => number = Date.now): LatLng {
  const [shown, setShown] = useState<LatLng>(target);
  const shownRef = useRef<LatLng>(target);
  const lastTargetAt = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    const from = shownRef.current;
    const startMs = now();
    const durationMs = glideDurationMs(from, target, lastTargetAt.current, startMs);
    lastTargetAt.current = startMs;
    if (durationMs === 0) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }
    const timer = setInterval(() => {
      const next = glidePosition(from, target, startMs, durationMs, now());
      shownRef.current = next;
      setShown(next);
      if (next.latitude === target.latitude && next.longitude === target.longitude) clearInterval(timer);
    }, GLIDE_FRAME_MS);
    return () => clearInterval(timer);
    // La cible se compare par valeur : un nouvel objet à la même position ne relance rien.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.latitude, target.longitude, enabled]);

  return enabled ? shown : target;
}
