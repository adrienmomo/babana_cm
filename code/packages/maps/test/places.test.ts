/**
 * searchPlace / reverseGeocode (L6-01, critère d'acceptation 4) -- `fetch` est mocké, aucun
 * appel réseau réel ni SDK.
 */
import { configureGoogleMapsProvider, _resetGoogleMapsApiKeyForTests } from '../src/providers/google/config';
import { reverseGeocode, searchPlace } from '../src/providers/google/places';

function mockFetchOnce(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
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

  it('traduit une réponse Places en résultats propres au paquet', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key' });
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
    configureGoogleMapsProvider({ apiKey: 'test-key' });
    mockFetchOnce({ status: 'ZERO_RESULTS' });

    await expect(searchPlace('lieu inconnu')).resolves.toEqual([]);
  });

  it('un statut Google en erreur lève une exception explicite', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-key' });
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
});
