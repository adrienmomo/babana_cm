import type { LatLng, RouteResult } from './types';
import { getRoutingUrl } from './routingConfig';

/**
 * Plafond de points d'un tracé renvoyé : borne de transport, alignée sur le contrat du fil
 * (`route.share`, 1000 points) avec une marge. Un tracé de ville simplifié à ce niveau reste
 * visuellement identique sur une carte de téléphone.
 */
const MAX_POINTS = 500;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Itinéraire `from` -> `to`. É8 : le modèle de routage est celui d'une voiture (ni Google ni
 * Mapbox -- ni OSRM ici -- ne calculent de deux-roues au Cameroun) : le tracé est juste, la durée
 * est indicative. Ne rejette jamais : `null` si le service n'est pas configuré, injoignable, ou
 * ne trouve aucun chemin -- l'écran garde alors la carte sans tracé, jamais un tracé inventé.
 */
export async function fetchRoute(from: LatLng, to: LatLng): Promise<RouteResult | null> {
  const base = getRoutingUrl();
  if (!base) return null;

  const url =
    `${base}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}` +
    '?overview=full&geometries=geojson&alternatives=false&steps=false';

  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let response: Response;
    try {
      response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) return null;

    const body = (await response.json()) as {
      code?: string;
      routes?: Array<{ distance?: number; duration?: number; geometry?: { coordinates?: Array<[number, number]> } }>;
    };
    const route = body.code === 'Ok' ? body.routes?.[0] : undefined;
    const coordinates = route?.geometry?.coordinates;
    if (!route || !coordinates || coordinates.length < 2) return null;

    const points = simplify(
      coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
      MAX_POINTS
    );
    return {
      points,
      distanceMeters: typeof route.distance === 'number' ? route.distance : null,
      durationSeconds: typeof route.duration === 'number' ? route.duration : null,
    };
  } catch {
    return null;
  }
}

/** Douglas-Peucker (itératif, pas de récursion sur des milliers de points), tolérance doublée
 * jusqu'à passer sous `maxPoints`. Garde toujours le premier et le dernier point. */
function simplify(points: LatLng[], maxPoints: number): LatLng[] {
  if (points.length <= maxPoints) return points;
  let tolerance = 0.000005; // ~0,5 m en degrés
  let result = points;
  while (result.length > maxPoints) {
    result = douglasPeucker(points, tolerance);
    tolerance *= 2;
  }
  return result;
}

function douglasPeucker(points: LatLng[], tolerance: number): LatLng[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop() as [number, number];
    let maxDistance = 0;
    let index = -1;
    const a = points[start] as LatLng;
    const b = points[end] as LatLng;
    for (let i = start + 1; i < end; i += 1) {
      const d = perpendicularDistance(points[i] as LatLng, a, b);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function perpendicularDistance(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.longitude - a.longitude, p.latitude - a.latitude);
  const t = Math.max(0, Math.min(1, ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) / lengthSquared));
  return Math.hypot(p.longitude - (a.longitude + t * dx), p.latitude - (a.latitude + t * dy));
}
