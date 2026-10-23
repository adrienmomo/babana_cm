/**
 * searchPlace / reverseGeocode (L6-01, critère d'acceptation 4) -- `fetch` est mocké, aucun
 * appel réseau réel ni SDK.
 */
import { configureGoogleMapsProvider, _resetGoogleMapsApiKeyForTests } from '../src/providers/google/config';
import { reverseGeocode, searchPlace } from '../src/providers/google/places';

// Adresse Google réelle -- Places API (New), Text Search. L'API historique
// (`maps/api/place/textsearch/json`) n'est plus ouverte aux nouveaux projets Google Cloud :
// constaté le 22 octobre, REQUEST_DENIED « legacy API not enabled » sur le projet de babana.
// Depuis D43, `searchUrl` doit toujours être posé explicitement.
const GOOGLE_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

function lastRequest(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = (global.fetch as jest.Mock).mock.calls.at(-1) as [string, RequestInit & { headers: Record<string, string> }];
  return { url, init };
}

describe('searchPlace / reverseGeocode (fournisseur Google)', () => {
  afterEach(() => {
    _resetGoogleMapsApiKeyForTests();
    jest.restoreAllMocks();
  });

  it('exige une clé configurée avant tout appel (invariant 5)', async () => {
    await expect(searchPlace('Akwa')).rejects.toThrow(/configureMapsProvider/);
  });

  // D43 (amoa/questions/REPONSES-2026-08-28.md §4) : un `searchUrl` non configuré échoue
  // bruyamment, il ne retombe plus silencieusement sur l'adresse Google réelle -- c'est
  // exactement ce repli qui a rendu la double instanciation du module invisible une nuit
  // entière avant d'être trouvée en lisant le trafic réseau plutôt que le code.
  it('exige aussi une adresse configurée, plutôt que de retomber sur Google (D43)', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key' });
    mockFetchOnce({ places: [] });

    await expect(searchPlace('Akwa')).rejects.toThrow(/configureMapsProvider/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('interroge Places API (New) : POST JSON, clé et masque de champs en en-têtes, biais sur le Cameroun', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({ places: [] });

    await searchPlace('Akwa');

    const { url, init } = lastRequest();
    expect(url).toBe(GOOGLE_SEARCH_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    // Le masque est obligatoire chez Google, et c'est lui qui fixe le prix de l'appel : seulement
    // ce que l'écran affiche.
    expect(init.headers['X-Goog-FieldMask']).toBe('places.displayName,places.formattedAddress,places.location');
    expect(JSON.parse(init.body as string)).toEqual({ textQuery: 'Akwa', regionCode: 'cm', languageCode: 'fr' });
  });

  it('traduit une réponse Places en résultats propres au paquet', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({
      places: [
        { displayName: { text: 'Akwa', languageCode: 'fr' }, formattedAddress: 'Akwa, Douala, Cameroun', location: { latitude: 4.05, longitude: 9.7 } },
        { displayName: { text: 'Marché Central' }, location: { latitude: 4.04, longitude: 9.69 } },
      ],
    });

    const results = await searchPlace('Akwa');

    expect(results).toEqual([
      { label: 'Akwa', position: { latitude: 4.05, longitude: 9.7 } },
      { label: 'Marché Central', position: { latitude: 4.04, longitude: 9.69 } },
    ]);
  });

  it('aucun résultat : Google renvoie un objet vide, le paquet une liste vide', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({});

    await expect(searchPlace('lieu inconnu')).resolves.toEqual([]);
  });

  it('une erreur Google lève une exception explicite, avec son statut', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce(
      { error: { code: 403, message: 'Places API (New) has not been used in project', status: 'PERMISSION_DENIED' } },
      { ok: false, status: 403 }
    );

    await expect(searchPlace('Akwa')).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('une panne sans corps JSON lève une exception explicite, avec le code HTTP', async () => {
    configureGoogleMapsProvider({ apiKey: '', searchUrl: 'http://localhost:4001/v1/places:searchText' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    }) as unknown as typeof fetch;

    await expect(searchPlace('Akwa')).rejects.toThrow(/503/);
  });

  // D19 : mock-maps sert la même route et la même forme que Google -- une seule requête, seule
  // l'adresse change ; une clé vide n'envoie pas d'en-tête de clé.
  it('vers mock-maps (D19) : clé vide acceptée, aucun en-tête de clé envoyé', async () => {
    configureGoogleMapsProvider({ apiKey: '', searchUrl: 'http://localhost:4001/v1/places:searchText' });
    mockFetchOnce({ places: [{ displayName: { text: 'Akwa' }, location: { latitude: 4.05, longitude: 9.7 } }] });

    await expect(searchPlace('Akwa')).resolves.toEqual([{ label: 'Akwa', position: { latitude: 4.05, longitude: 9.7 } }]);
    expect(lastRequest().init.headers['X-Goog-Api-Key']).toBeUndefined();
  });

  it('géocode un point vers un libellé', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key' });
    mockFetchOnce({ status: 'OK', results: [{ formatted_address: 'Akwa, Douala' }] });

    await expect(reverseGeocode({ latitude: 4.05, longitude: 9.7 })).resolves.toBe('Akwa, Douala');
  });

  it('un point non géocodable renvoie null, pas une erreur', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key' });
    mockFetchOnce({ status: 'ZERO_RESULTS' });

    await expect(reverseGeocode({ latitude: 0, longitude: 0 })).resolves.toBeNull();
  });
});
