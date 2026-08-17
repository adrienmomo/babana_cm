import type { LatLng, PlaceResult } from '../../types';
import { getGoogleMapsApiKey } from './config';

/**
 * Recherche de lieu et géocodage inverse (L6-01, spécification) via les API REST Google Places
 * et Geocoding -- pas le SDK Places embarqué (react-native ne l'exposant pas nativement sans
 * dépendance supplémentaire, et ces deux appels sont de simples requêtes HTTP, testables sans
 * SDK réel, critère d'acceptation 4).
 */
const PLACES_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GooglePlacesTextSearchResult {
  name: string;
  geometry: { location: { lat: number; lng: number } };
}

interface GooglePlacesTextSearchResponse {
  status: string;
  results?: GooglePlacesTextSearchResult[];
}

interface GoogleGeocodeResponse {
  status: string;
  results?: Array<{ formatted_address: string }>;
}

export async function searchPlace(query: string): Promise<PlaceResult[]> {
  const url = new URL(PLACES_TEXT_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('key', getGoogleMapsApiKey());
  // Biais géographique sur le Cameroun, pas un filtre strict -- un repère ambigu doit rester
  // trouvable même mal centré (l'adresse formelle n'existe quasiment pas à Douala, CLAUDE.md).
  url.searchParams.set('region', 'cm');

  const response = await fetch(url.toString());
  const body = (await response.json()) as GooglePlacesTextSearchResponse;
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    throw new Error(`@babana/maps: recherche de lieu Google échouée (${body.status}).`);
  }

  return (body.results ?? []).map((result) => ({
    label: result.name,
    position: { latitude: result.geometry.location.lat, longitude: result.geometry.location.lng },
  }));
}

export async function reverseGeocode(point: LatLng): Promise<string | null> {
  const url = new URL(GEOCODE_URL);
  url.searchParams.set('latlng', `${point.latitude},${point.longitude}`);
  url.searchParams.set('key', getGoogleMapsApiKey());

  const response = await fetch(url.toString());
  const body = (await response.json()) as GoogleGeocodeResponse;
  if (body.status !== 'OK') return null;

  return body.results?.[0]?.formatted_address ?? null;
}
