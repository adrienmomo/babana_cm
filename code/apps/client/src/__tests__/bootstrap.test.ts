const mockConfigureMapsProvider = jest.fn();
jest.mock('@babana/maps', () => ({ configureMapsProvider: (...args: unknown[]) => mockConfigureMapsProvider(...args) }));
jest.mock('../../config', () => ({
  GOOGLE_MAPS_API_KEY: 'rest-key',
  MAPS_SEARCH_URL: 'https://search.example.test/search',
  MAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png',
  MAP_TILE_ATTRIBUTION: '© Tuiles Exemple',
}));

import { bootstrap } from '../bootstrap';

test("la carte native du Client suit l'adresse de tuiles configurée (OpenStreetMap), comme celle du Chauffeur", () => {
  bootstrap();
  expect(mockConfigureMapsProvider).toHaveBeenCalledWith({
    apiKey: 'rest-key',
    searchUrl: 'https://search.example.test/search',
    tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
    tileAttribution: '© Tuiles Exemple',
  });
});
