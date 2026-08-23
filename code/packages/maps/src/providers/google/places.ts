import type { LatLng, PlaceResult } from '../../types';
import { getGoogleMapsApiKey, getSearchUrl } from './config';

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

/** Forme servie par `mock-maps` (`GET /search`, D19) -- un quartier plat, sans enveloppe `status`. */
interface MockSearchResult {
  name: string;
  latitude: number;
  longitude: number;
}

interface MockSearchResponse {
  results?: MockSearchResult[];
}

type SearchResult = GooglePlacesTextSearchResult | MockSearchResult;
type SearchResponse = GooglePlacesTextSearchResponse | MockSearchResponse;

/**
 * Adaptateur de forme (`amoa/questions/C-01R.md` §2) : Google enveloppe chaque résultat dans
 * `geometry.location.{lat,lng}` et une enveloppe `status` ; `mock-maps` sert des quartiers plats
 * `{name,latitude,longitude}` sans `status` du tout. Une seule requête part vers `searchUrl`
 * (config.ts), quel que soit le fournisseur qui la sert -- ce qui distingue les deux formes ici
 * est la présence des champs dans la réponse, jamais une lecture de l'environnement.
 */
function normalizeSearchResult(result: SearchResult): PlaceResult {
  if ('geometry' in result) {
    return {
      label: result.name,
      position: { latitude: result.geometry.location.lat, longitude: result.geometry.location.lng },
    };
  }
  return { label: result.name, position: { latitude: result.latitude, longitude: result.longitude } };
}

export async function searchPlace(query: string): Promise<PlaceResult[]> {
  const url = new URL(getSearchUrl(PLACES_TEXT_SEARCH_URL));
  // `query` (Google) et `q` (mock-maps, D19) portées toutes les deux -- chaque serveur ignore le
  // paramètre qu'il ne connaît pas, ce qui évite de faire dépendre le nom du paramètre du
  // fournisseur ciblé.
  url.searchParams.set('query', query);
  url.searchParams.set('q', query);
  const apiKey = getGoogleMapsApiKey();
  if (apiKey) url.searchParams.set('key', apiKey);
  // Biais géographique sur le Cameroun, pas un filtre strict -- un repère ambigu doit rester
  // trouvable même mal centré (l'adresse formelle n'existe quasiment pas à Douala, CLAUDE.md).
  url.searchParams.set('region', 'cm');

  const response = await fetch(url.toString());
  const body = (await response.json()) as SearchResponse;
  if ('status' in body && body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    throw new Error(`@babana/maps: recherche de lieu Google échouée (${body.status}).`);
  }
  if (!response.ok && !('status' in body)) {
    throw new Error(`@babana/maps: recherche de lieu échouée (HTTP ${response.status}).`);
  }

  return (body.results ?? []).map(normalizeSearchResult);
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
