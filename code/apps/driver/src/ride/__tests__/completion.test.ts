import { buildCompletionBody, encodePolyline } from '../completion';

const ORIGIN = { latitude: 4.05, longitude: 9.7 };
const DESTINATION = { latitude: 4.061, longitude: 9.71 };

describe('encodePolyline', () => {
  it("produit l'exemple canonique de l'algorithme Google", () => {
    // (38.5, -120.2), (40.7, -120.95), (43.252, -126.453) -> exemple de la doc Google.
    expect(
      encodePolyline([
        { latitude: 38.5, longitude: -120.2 },
        { latitude: 40.7, longitude: -120.95 },
        { latitude: 43.252, longitude: -126.453 },
      ])
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('encode une ligne à deux points en une chaîne non vide', () => {
    expect(encodePolyline([ORIGIN, DESTINATION]).length).toBeGreaterThan(0);
  });
});

describe('buildCompletionBody (L6-13, ÉCART amoa/questions/L6-13.md)', () => {
  it('durationSeconds vient de l’horloge (démarrage observé -> maintenant), jamais devinée', () => {
    const startedAtMs = 1_000_000;
    const body = buildCompletionBody({
      referenceDistanceMeters: 3200,
      startedAtMs,
      now: startedAtMs + 512_000,
      origin: ORIGIN,
      destination: DESTINATION,
    });
    expect(body.durationSeconds).toBe(512);
  });

  it('distanceMeters est la distance de référence (arrondie), pas une mesure', () => {
    const body = buildCompletionBody({
      referenceDistanceMeters: 3249.6,
      startedAtMs: 0,
      now: 1000,
      origin: ORIGIN,
      destination: DESTINATION,
    });
    expect(body.distanceMeters).toBe(3250);
  });

  it('polyline encode la ligne droite départ -> arrivée (non vide)', () => {
    const body = buildCompletionBody({ referenceDistanceMeters: 3200, startedAtMs: 0, now: 1000, origin: ORIGIN, destination: DESTINATION });
    expect(body.polyline).toBe(encodePolyline([ORIGIN, DESTINATION]));
    expect(body.polyline.length).toBeGreaterThan(0);
  });

  it('une durée négative (horloge incohérente) est ramenée à zéro, jamais négative', () => {
    const body = buildCompletionBody({ referenceDistanceMeters: 3200, startedAtMs: 5000, now: 1000, origin: ORIGIN, destination: DESTINATION });
    expect(body.durationSeconds).toBe(0);
  });
});
