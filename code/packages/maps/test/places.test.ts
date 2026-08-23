/**
 * searchPlace / reverseGeocode (L6-01, critère d'acceptation 4) -- `fetch` est mocké, aucun
 * appel réseau réel ni SDK.
 */
import { configureGoogleMapsProvider, _resetGoogleMapsApiKeyForTests } from '../src/providers/google/config';
import { reverseGeocode, searchPlace } from '../src/providers/google/places';

// Adresse Google réelle -- ces tests exercent la forme des réponses du vrai fournisseur, jamais
// un défaut de configuration : depuis D43, `searchUrl` doit toujours être posé explicitement.
const GOOGLE_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
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
    mockFetchOnce({ status: 'OK', results: [] });

    await expect(searchPlace('Akwa')).rejects.toThrow(/configureMapsProvider/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('traduit une réponse Places en résultats propres au paquet', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({
      status: 'OK',
      results: [
        { name: 'Akwa', geometry: { location: { lat: 4.05, lng: 9.7 } } },
        { name: 'Bonanjo', geometry: { location: { lat: 4.04, lng: 9.69 } } },
      ],
    });

    const results = await searchPlace('Akwa');

    expect(results).toEqual([
      { label: 'Akwa', position: { latitude: 4.05, longitude: 9.7 } },
      { label: 'Bonanjo', position: { latitude: 4.04, longitude: 9.69 } },
    ]);
  });

  it('un ZERO_RESULTS produit une liste vide, pas une erreur', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({ status: 'ZERO_RESULTS' });

    await expect(searchPlace('lieu inconnu')).resolves.toEqual([]);
  });

  it('un statut Google en erreur lève une exception explicite', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: GOOGLE_SEARCH_URL });
    mockFetchOnce({ status: 'REQUEST_DENIED' });

    await expect(searchPlace('Akwa')).rejects.toThrow(/REQUEST_DENIED/);
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

  // D19, amoa/questions/C-01R.md §2 : recherche de lieu routée vers mock-maps en développement.
  describe('vers mock-maps (D19)', () => {
    it('une clé vide est acceptée -- mock-maps ne la consomme pas', async () => {
      configureGoogleMapsProvider({ apiKey: '', searchUrl: 'http://localhost:4001/search' });
      mockFetchOnce({ results: [{ id: 'akwa', name: 'Akwa', latitude: 4.05, longitude: 9.7 }] });

      await expect(searchPlace('Akwa')).resolves.toEqual([
        { label: 'Akwa', position: { latitude: 4.05, longitude: 9.7 } },
      ]);
    });

    it("traduit la forme plate de mock-maps, sans enveloppe status", async () => {
      configureGoogleMapsProvider({ apiKey: 'test-key', searchUrl: 'http://localhost:4001/search' });
      mockFetchOnce({
        results: [
          { id: 'akwa', name: 'Akwa', latitude: 4.05, longitude: 9.7 },
          { id: 'bonanjo', name: 'Bonanjo', latitude: 4.04, longitude: 9.69 },
        ],
      });

      await expect(searchPlace('Ak')).resolves.toEqual([
        { label: 'Akwa', position: { latitude: 4.05, longitude: 9.7 } },
        { label: 'Bonanjo', position: { latitude: 4.04, longitude: 9.69 } },
      ]);
    });

    it("envoie le paramètre `q` de mock-maps vers l'URL configurée", async () => {
      configureGoogleMapsProvider({ apiKey: '', searchUrl: 'http://localhost:4001/search' });
      mockFetchOnce({ results: [] });

      await searchPlace('Akwa');

      const calledUrl = new URL((global.fetch as jest.Mock).mock.calls[0][0] as string);
      expect(calledUrl.origin + calledUrl.pathname).toBe('http://localhost:4001/search');
      expect(calledUrl.searchParams.get('q')).toBe('Akwa');
    });

    it('une panne HTTP sans enveloppe status lève une exception explicite', async () => {
      configureGoogleMapsProvider({ apiKey: '', searchUrl: 'http://localhost:4001/search' });
      mockFetchOnce({ error: 'panne simulée' }, { ok: false, status: 503 });

      await expect(searchPlace('Akwa')).rejects.toThrow(/503/);
    });
  });
});
