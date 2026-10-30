import type { LatLng, PlaceResult } from '../../types';
import { getGeocodeUrl, getGoogleMapsApiKey, getSearchUrl } from './config';

/**
 * Recherche de lieu et géocodage inverse (L6-01, spécification) via les API REST Google -- pas le
 * SDK Places embarqué (react-native ne l'exposant pas nativement sans dépendance supplémentaire,
 * et ces deux appels sont de simples requêtes HTTP, testables sans SDK réel, critère
 * d'acceptation 4). L'adresse de recherche (`searchPlace`) n'a pas de valeur en dur ici (D43) --
 * `getSearchUrl` (config.ts) l'exige configurée.
 *
 * **Places API (New), Text Search** (22 octobre) : `POST https://places.googleapis.com/v1/
 * places:searchText`. L'API historique (`maps/api/place/textsearch/json`, GET) n'est plus ouverte
 * aux nouveaux projets Google Cloud -- constaté sur le projet de babana : REQUEST_DENIED, « legacy
 * API not enabled ». mock-maps (D19) sert la même route et la même forme : une seule requête part,
 * seule l'adresse change.
 */
/** Le masque est obligatoire chez Google et fixe le prix de l'appel : seulement ce que l'écran
 * affiche (libellé, position). `formattedAddress` en plus, pour lever l'ambiguïté d'un repère. */
const SEARCH_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location';

interface GooglePlace {
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
}

/** Sans résultat, Google renvoie `{}` ; en erreur, `{ error: { code, message, status } }`. */
interface GoogleSearchTextResponse {
  places?: GooglePlace[];
  error?: { code: number; message: string; status: string };
}

interface GoogleGeocodeResponse {
  status: string;
  results?: Array<{ formatted_address: string }>;
}

function toPlaceResult(place: GooglePlace): PlaceResult | null {
  const label = place.displayName?.text ?? place.formattedAddress;
  if (!label || !place.location) return null;
  return { label, position: { latitude: place.location.latitude, longitude: place.location.longitude } };
}

export async function searchPlace(query: string): Promise<PlaceResult[]> {
  const url = getSearchUrl();
  const apiKey = getGoogleMapsApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Goog-FieldMask': SEARCH_FIELD_MASK,
  };
  // Clé vide : mock-maps en développement (D19), qui n'en consomme aucune.
  if (apiKey) headers['X-Goog-Api-Key'] = apiKey;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    // Biais sur le Cameroun, pas un filtre strict -- un repère ambigu doit rester trouvable même
    // mal centré (l'adresse formelle n'existe quasiment pas à Douala, CLAUDE.md).
    body: JSON.stringify({ textQuery: query, regionCode: 'cm', languageCode: 'fr' }),
  });
  const body = (await response.json().catch(() => null)) as GoogleSearchTextResponse | null;
  if (!response.ok || body === null || body.error) {
    const reason = body?.error ? `${body.error.status} : ${body.error.message}` : `HTTP ${response.status}`;
    throw new Error(`@babana/maps: recherche de lieu échouée (${reason}).`);
  }

  return (body.places ?? []).map(toPlaceResult).filter((result): result is PlaceResult => result !== null);
}

export async function reverseGeocode(point: LatLng): Promise<string | null> {
  const apiKey = getGoogleMapsApiKey();
  const url = new URL(getGeocodeUrl());
  url.searchParams.set('latlng', `${point.latitude},${point.longitude}`);
  // Clé vide : mock-maps en développement (D19), même règle que searchPlace.
  if (apiKey) url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  const body = (await response.json()) as GoogleGeocodeResponse;
  if (body.status !== 'OK') return null;

  return body.results?.[0]?.formatted_address ?? null;
}
