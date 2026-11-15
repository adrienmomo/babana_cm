const mockConfigureMapsProvider = jest.fn();
jest.mock('@babana/maps', () => ({ configureMapsProvider: (...args: unknown[]) => mockConfigureMapsProvider(...args) }));
jest.mock('../proposalAlert', () => ({ configureProposalAlerts: jest.fn() }));
jest.mock('../location', () => ({ locationTracker: { start: jest.fn() } }));
const mockStartProposalWatch = jest.fn();
jest.mock('../proposalWatch', () => ({ startProposalWatch: () => mockStartProposalWatch() }));
jest.mock('../../config', () => ({
  GOOGLE_MAPS_API_KEY: 'rest-key',
  MAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png',
  MAP_TILE_ATTRIBUTION: '© Tuiles Exemple',
  ROUTING_URL: 'https://router.example.test',
}));

import { bootstrap } from '../bootstrap';

test("la carte du Chauffeur est OpenStreetMap : l'adresse des tuiles configurée est transmise, avec la clé Google pour la recherche", () => {
  bootstrap();
  expect(mockConfigureMapsProvider).toHaveBeenCalledWith({
    apiKey: 'rest-key',
    tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
    tileAttribution: '© Tuiles Exemple',
    routingUrl: 'https://router.example.test',
  });
});

test('14 novembre : la veille des propositions app fermée démarre avec l’app, indépendamment des écrans', () => {
  bootstrap();
  expect(mockStartProposalWatch).toHaveBeenCalledTimes(1);
});
