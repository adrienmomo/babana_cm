// Géocodage inverse simulé (mock-maps, D19) : le repère le plus proche, sous la forme de la
// Geocoding API de Google. C'est ce qu'affiche l'app Client (« vers <repère> ») en développement et
// pendant la démonstration -- avant le 30 octobre, elle affichait des coordonnées brutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(__filename);
const MOCK_ROOT = path.resolve(__dirname, '../../services/mocks/maps');
const { geocodeResponse, nearestPlace, MAX_DISTANCE_METERS } = require(path.join(MOCK_ROOT, 'src/geocode.js')) as {
  geocodeResponse: (places: Place[], point: Point) => { status: string; results: Array<{ formatted_address: string }> };
  nearestPlace: (places: Place[], point: Point) => Place | null;
  MAX_DISTANCE_METERS: number;
};

type Point = { latitude: number; longitude: number };
type Place = Point & { id: string; name: string };
const places = (JSON.parse(readFileSync(path.join(MOCK_ROOT, 'fixtures/douala.json'), 'utf8')) as { places: Place[] }).places;

test('le repère le plus proche du point, au format Google', () => {
  const tiff = places.find((place) => place.id === 'carrefour-tiff');
  assert.ok(tiff);
  const nearTiff = { latitude: tiff.latitude + 0.0002, longitude: tiff.longitude };
  assert.deepEqual(geocodeResponse(places, nearTiff), {
    status: 'OK',
    results: [{ formatted_address: 'Carrefour Tiff, Douala' }],
  });
});

test('hors de portée de tout repère : ZERO_RESULTS, comme Google', () => {
  assert.equal(nearestPlace(places, { latitude: 3.5, longitude: 10.5 }), null);
  assert.equal(geocodeResponse(places, { latitude: 3.5, longitude: 10.5 }).status, 'ZERO_RESULTS');
  assert.ok(MAX_DISTANCE_METERS > 0);
});

test('chaque repère de la fixture est à Douala et a un identifiant unique', () => {
  const ids = new Set(places.map((place) => place.id));
  assert.equal(ids.size, places.length);
  for (const place of places) {
    assert.ok(place.latitude > 3.9 && place.latitude < 4.2, place.id);
    assert.ok(place.longitude > 9.6 && place.longitude < 9.9, place.id);
  }
});
