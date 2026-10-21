const mockConfigureMapsProvider = jest.fn();
jest.mock('@babana/maps', () => ({ configureMapsProvider: (...args: unknown[]) => mockConfigureMapsProvider(...args) }));
jest.mock('../proposalAlert', () => ({ configureProposalAlerts: jest.fn() }));
jest.mock('../location', () => ({ locationTracker: { start: jest.fn() } }));
jest.mock('../../config', () => ({
  GOOGLE_MAPS_API_KEY: 'rest-key',
  MAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png',
}));

import { bootstrap } from '../bootstrap';

test("la carte du Chauffeur est OpenStreetMap : l'adresse des tuiles configurée est transmise, avec la clé Google pour la recherche", () => {
  bootstrap();
  expect(mockConfigureMapsProvider).toHaveBeenCalledWith({
    apiKey: 'rest-key',
    tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
  });
});
