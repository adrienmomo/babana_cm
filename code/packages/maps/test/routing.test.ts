/**
 * fetchRoute -- itinéraire entre deux points, calculé par un service de routage configurable
 * (format OSRM). `fetch` est mocké : aucun appel réseau réel.
 */
import { configureMapsProvider } from '../src/configure';
import { fetchRoute } from '../src/routing';
import { _resetRoutingUrlForTests } from '../src/routingConfig';

const FROM = { latitude: 4.05, longitude: 9.76 };
const TO = { latitude: 4.07, longitude: 9.78 };
const ROUTING_URL = 'https://router.example.test';

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = jest.fn().mockResolvedValue({ ok: init.ok ?? true, status: init.status ?? 200, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function osrmBody(coordinates: Array<[number, number]>, distance = 3100, duration = 520) {
  return { code: 'Ok', routes: [{ distance, duration, geometry: { type: 'LineString', coordinates } }] };
}

describe('fetchRoute', () => {
  afterEach(() => {
    _resetRoutingUrlForTests();
    jest.restoreAllMocks();
  });

  it('exige une adresse de routage configurée (invariant 5), sans appel réseau', async () => {
    const fn = mockFetch(osrmBody([]));
    await expect(fetchRoute(FROM, TO)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('interroge le service en longitude,latitude et renvoie les points en latitude/longitude', async () => {
    configureMapsProvider({ apiKey: 'k', routingUrl: ROUTING_URL });
    const fn = mockFetch(osrmBody([[9.76, 4.05], [9.77, 4.06], [9.78, 4.07]]));

    const route = await fetchRoute(FROM, TO);

    const url = String(fn.mock.calls[0][0]);
    expect(url.startsWith(`${ROUTING_URL}/route/v1/driving/9.76,4.05;9.78,4.07?`)).toBe(true);
    expect(url).toContain('geometries=geojson');
    expect(route).toEqual({
      points: [
        { latitude: 4.05, longitude: 9.76 },
        { latitude: 4.06, longitude: 9.77 },
        { latitude: 4.07, longitude: 9.78 },
      ],
      distanceMeters: 3100,
      durationSeconds: 520,
    });
  });

  it('renvoie null sur une erreur réseau, une réponse HTTP en échec ou un code OSRM en échec', async () => {
    configureMapsProvider({ apiKey: 'k', routingUrl: ROUTING_URL });
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(fetchRoute(FROM, TO)).resolves.toBeNull();

    mockFetch({}, { ok: false, status: 500 });
    await expect(fetchRoute(FROM, TO)).resolves.toBeNull();

    mockFetch({ code: 'NoRoute', routes: [] });
    await expect(fetchRoute(FROM, TO)).resolves.toBeNull();
  });

  it('simplifie un long tracé sous le plafond de points, en gardant le départ et l’arrivée', async () => {
    configureMapsProvider({ apiKey: 'k', routingUrl: ROUTING_URL });
    // 5000 points sur une courbe : trop pour le fil.
    const coordinates: Array<[number, number]> = Array.from({ length: 5000 }, (_, i) => [
      9.76 + i * 0.00001,
      4.05 + Math.sin(i / 50) * 0.002 + i * 0.00001,
    ]);
    mockFetch(osrmBody(coordinates));

    const route = await fetchRoute(FROM, TO);

    expect(route).not.toBeNull();
    expect(route!.points.length).toBeLessThanOrEqual(500);
    expect(route!.points.length).toBeGreaterThan(10);
    expect(route!.points[0]).toEqual({ latitude: coordinates[0][1], longitude: coordinates[0][0] });
    expect(route!.points[route!.points.length - 1]).toEqual({
      latitude: coordinates[4999][1],
      longitude: coordinates[4999][0],
    });
  });
});
