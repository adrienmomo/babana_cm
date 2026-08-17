import { activeMapProvider } from './activeProvider';
import type { LatLng, PlaceResult } from './types';

/** Recherche de lieu par texte (L6-06, complément à la désignation sur carte). */
export function searchPlace(query: string): Promise<PlaceResult[]> {
  return activeMapProvider.searchPlace(query);
}

/** Géocodage inverse d'un point vers un libellé (L6-06, désignation sous le réticule). */
export function reverseGeocode(point: LatLng): Promise<string | null> {
  return activeMapProvider.reverseGeocode(point);
}
