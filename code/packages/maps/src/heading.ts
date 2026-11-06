import type { LatLng } from './types';

/**
 * Cap d'un repère d'après ses positions successives -- la même règle que la page Leaflet
 * (`providers/osm/leafletHtml.ts`, `headingFor`), qui la porte dans son propre JavaScript parce
 * qu'elle s'exécute dans une WebView. Ici pour les fournisseurs natifs.
 */

/** En deçà de ce décalage (degrés, ~1 m), un « nouveau centre » est le même point -- évite la
 * boucle déplacement -> onRegionChange -> centre -> déplacement. Partagé par Leaflet et Google. */
export const RECENTER_EPSILON = 0.00001;

/** En deçà de ce déplacement (degrés, ~5 m), un relevé est du bruit GPS : le cap ne change pas. */
export const MIN_HEADING_MOVE_DEG = 0.00005;

/** Cap géographique de `from` vers `to`, en degrés de 0 (nord) à 360, sens horaire. */
export function bearingBetween(from: LatLng, to: LatLng): number {
  const toRad = Math.PI / 180;
  const lat1 = from.latitude * toRad;
  const lat2 = to.latitude * toRad;
  const dLng = (to.longitude - from.longitude) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** Retient, par identifiant de repère, la dernière position significative et son cap. */
export function createHeadingTracker() {
  const last = new Map<string, { position: LatLng; bearing: number }>();
  return function headingFor(id: string, position: LatLng): number {
    const previous = last.get(id);
    if (!previous) {
      last.set(id, { position, bearing: 0 });
      return 0;
    }
    const moved =
      Math.abs(previous.position.latitude - position.latitude) > MIN_HEADING_MOVE_DEG ||
      Math.abs(previous.position.longitude - position.longitude) > MIN_HEADING_MOVE_DEG;
    if (!moved) return previous.bearing;
    const bearing = bearingBetween(previous.position, position);
    last.set(id, { position, bearing });
    return bearing;
  };
}
