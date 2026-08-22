import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// Même mock que HomeScreen.test.tsx (`../realtime` porte le WebSocket partagé de l'app) --
// QuoteScreen ouvre désormais son propre abonnement `nearby.subscribe` (doute du 24 août) plutôt
// que de dépendre d'un cliché figé transmis par HomeScreen.
let realtimeListener: ((message: unknown) => void) | null = null;
let connectionStateListener: ((state: string) => void) | null = null;
const mockSend = jest.fn();
const mockEnsureConnected = jest.fn();
jest.mock('../../realtime', () => ({
  ensureRealtimeConnected: () => mockEnsureConnected(),
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  onRealtimeConnectionStateChange: (listener: (state: string) => void) => {
    connectionStateListener = listener;
    return () => {
      connectionStateListener = null;
    };
  },
  realtimeClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

import { QuoteScreen } from '../QuoteScreen';

function emitNearbyDrivers(drivers: http.NearbyDriver[]) {
  realtimeListener?.({ type: 'nearby.drivers', id: 'm1', emittedAt: new Date().toISOString(), payload: { drivers } });
}

const ORIGIN = { position: { latitude: 4.0511, longitude: 9.7679 }, label: 'vers Akwa, Douala' };
const DESTINATION = { position: { latitude: 4.0611, longitude: 9.7861 }, label: 'vers Bonapriso, Douala' };

function driver(overrides: Partial<http.NearbyDriver> = {}): http.NearbyDriver {
  return {
    driverId: 'driver-1',
    firstName: 'Paul',
    photoUrl: null,
    rating: 4.8,
    motorcycleClass: 'standard',
    position: { latitude: 4.061, longitude: 9.711 },
    distanceMeters: 350,
    ...overrides,
  };
}

function quoteResponse(overrides: Partial<http.QuoteResponse> = {}): http.QuoteResponse {
  return {
    quoteId: '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c',
    amount: 1200,
    currency: 'XAF',
    breakdown: {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    },
    distanceMeters: 4200,
    etaSeconds: 780,
    promoApplied: false,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function fakeNavigation() {
  return { navigate: jest.fn(), reset: jest.fn() };
}

// QuoteScreen tient un setInterval réel (compte à rebours de validité) -- sans démontage
// explicite, il continue de tourner après la fin de chaque test et finit par se déclencher après
// que Jest a démonté son environnement (`ReferenceError: ... after the Jest environment has been
// torn down`). Chaque rendu est donc suivi ici pour être démonté en `afterEach`.
const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderQuote(
  params: {
    origin?: typeof ORIGIN;
    destination?: typeof DESTINATION;
    nearbyDrivers?: http.NearbyDriver[];
    excludedDriverIds?: string[];
    rejectionStreak?: number;
    rideId?: string;
  } = {},
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'Quote',
    name: 'Quote' as const,
    params: {
      origin: params.origin ?? ORIGIN,
      destination: params.destination ?? DESTINATION,
      nearbyDrivers: params.nearbyDrivers ?? [driver()],
      excludedDriverIds: params.excludedDriverIds ?? [],
      rejectionStreak: params.rejectionStreak ?? 0,
      rideId: params.rideId,
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<QuoteScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

// `toLocaleString('fr-FR')` sépare les milliers par une espace fine insécable (U+202F), pas une
// espace ordinaire -- comparer contre la même fonction plutôt que contre une chaîne tapée à la
// main, sans quoi le test dépend d'un caractère qu'on ne voit pas à l'œil nu dans un éditeur.
function fcfa(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  connectionStateListener = null;
  mockRequest.mockImplementation(async (name: string) => {
    if (name === 'quote') return quoteResponse();
    throw new Error(`unexpected call: ${name}`);
  });
});

describe('QuoteScreen (L6-07)', () => {
  it('critère 1 : le détail décomposé est visible sans interaction supplémentaire', async () => {
    const { root } = await renderQuote();

    expect(texts(root)).toContain(fcfa(1200));
    expect(root.root.findByProps({ testID: 'fare-breakdown' })).toBeTruthy();
    expect(texts(root)).toContain('Prise en charge');
    expect(texts(root)).toContain(fcfa(200));
    expect(texts(root)).toContain('Distance');
    expect(texts(root)).toContain(fcfa(1000));
  });

  it('les composantes non nulles du détail somment exactement le total affiché', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') {
        return quoteResponse({
          amount: 1450,
          breakdown: {
            baseFare: 200,
            distanceFare: 1000,
            surgeAmount: 300,
            discountAmount: 100,
            floorAmount: 0,
            roundingAmount: 50,
            minimumFareApplied: false,
          },
        });
      }
      throw new Error('unexpected');
    });

    const { root } = await renderQuote();

    // 200 + 1000 + 300 - 100 + 50 = 1450, exactement le montant affiché.
    expect(texts(root)).toContain(fcfa(1450));
    expect(texts(root)).toContain('Majoration');
    expect(texts(root)).toContain(fcfa(300));
    expect(texts(root)).toContain('Remise');
    expect(texts(root)).toContain(`-${fcfa(100)}`);
    expect(texts(root)).toContain('Arrondi');
    expect(texts(root)).toContain(fcfa(50));
    // Ligne nulle (floorAmount) absente -- l'identité tient sans elle.
    expect(texts(root)).not.toContain('Ajustement plancher');
  });

  it('critère 2 : les 5 chauffeurs sont affichés avec les seules données du contrat (C-02)', async () => {
    const drivers = [driver({ driverId: 'a', firstName: 'Paul' }), driver({ driverId: 'b', firstName: 'Aminata', rating: null })];
    const { root } = await renderQuote({ nearbyDrivers: drivers });

    expect(texts(root)).toContain('Paul');
    expect(texts(root)).toContain('Aminata');
    expect(root.root.findByProps({ testID: 'driver-card-a' })).toBeTruthy();
    expect(root.root.findByProps({ testID: 'driver-card-b' })).toBeTruthy();
  });

  it('critère 3 : un chauffeur sans avis suffisants est marqué « nouveau »', async () => {
    const { root } = await renderQuote({ nearbyDrivers: [driver({ rating: null })] });

    expect(texts(root)).toContain('Nouveau');
  });

  it('le changement de gamme relance l’estimation côté serveur, jamais un recalcul local (critère 5)', async () => {
    const { root } = await renderQuote();
    mockRequest.mockClear();
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') return quoteResponse({ amount: 1800, breakdown: { ...quoteResponse().breakdown, distanceFare: 1600 } });
      throw new Error('unexpected');
    });

    await act(async () => {
      root.root.findByProps({ testID: 'vehicle-class-premium' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('quote', expect.objectContaining({ body: expect.objectContaining({ vehicleClass: 'premium' }) }));
    expect(texts(root)).toContain(fcfa(1800));
  });

  it('critère 4 : l’expiration propose une réactualisation plutôt que d’échouer', async () => {
    jest.useFakeTimers();
    const { root } = await renderQuote();

    // Force l'expiration en avançant l'horloge au-delà de expiresAt (5 min dans le futur).
    await act(async () => {
      jest.advanceTimersByTime(6 * 60_000);
    });

    expect(root.root.findByProps({ testID: 'refresh-quote' })).toBeTruthy();
    jest.useRealTimers();
  });

  it("choisir un chauffeur crée la course puis l'affecte, et remplace la pile par l'attente (L6-00)", async () => {
    const proposalExpiresAt = new Date(Date.now() + 30_000).toISOString();
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') return quoteResponse();
      if (name === 'createRide') return { id: 'ride-1', state: 'requested' };
      if (name === 'selectDriver') return { id: 'ride-1', state: 'proposed', amount: 1200, currency: 'XAF', proposalExpiresAt };
      throw new Error(`unexpected call: ${name}`);
    });
    const { root, navigation } = await renderQuote({ nearbyDrivers: [driver({ driverId: 'chosen' })] });

    await act(async () => {
      root.root.findByProps({ testID: 'driver-card-chosen' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('createRide', expect.objectContaining({ body: { quoteId: quoteResponse().quoteId } }));
    expect(mockRequest).toHaveBeenCalledWith(
      'selectDriver',
      expect.objectContaining({ pathParams: { id: 'ride-1' }, body: { driverId: 'chosen' } })
    );
    // navigation.reset() (replaceWithRideFlow, navigation/transitions.ts), jamais navigate() --
    // un retour depuis l'attente ne doit pas ramener à cette estimation (piège du bouton retour
    // Android, L6-00).
    expect(navigation.reset).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 0,
        routes: [expect.objectContaining({ name: 'Waiting', params: expect.objectContaining({ rideId: 'ride-1', driverId: 'chosen' }) })],
      })
    );
    expect(navigation.navigate).not.toHaveBeenCalledWith('Waiting', expect.anything());
  });

  it('une course déjà créée (retour après un refus) réutilise le même rideId, sans nouveau createRide', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') return quoteResponse();
      if (name === 'selectDriver') return { id: 'ride-1', state: 'proposed', amount: 1200, currency: 'XAF', proposalExpiresAt: new Date().toISOString() };
      throw new Error(`unexpected call: ${name}`);
    });
    const { root } = await renderQuote({ nearbyDrivers: [driver({ driverId: 'second-choice' })], rideId: 'ride-1' });

    await act(async () => {
      root.root.findByProps({ testID: 'driver-card-second-choice' }).props.onPress();
    });

    expect(mockRequest).not.toHaveBeenCalledWith('createRide', expect.anything());
    expect(mockRequest).toHaveBeenCalledWith(
      'selectDriver',
      expect.objectContaining({ pathParams: { id: 'ride-1' }, body: { driverId: 'second-choice' } })
    );
  });

  it('critère 2 (L6-08) : un chauffeur déjà refusé sur cette course ne réapparaît plus', async () => {
    const drivers = [driver({ driverId: 'refused' }), driver({ driverId: 'still-here', firstName: 'Aminata' })];
    const { root } = await renderQuote({ nearbyDrivers: drivers, excludedDriverIds: ['refused'] });

    expect(root.root.findAllByProps({ testID: 'driver-card-refused' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'driver-card-still-here' })).toBeTruthy();
  });

  // Doute du 24 août (amoa/questions/REPONSES-2026-08-24.md §4) : l'abonnement reste actif
  // pendant que le client compare -- un chauffeur pris entre-temps doit disparaître ici, pas
  // seulement produire DRIVER_ALREADY_TAKEN une fois touché.
  it("s'abonne à nearby.subscribe au montage, sur le point de départ", async () => {
    await renderQuote();

    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', { position: ORIGIN.position, radiusMeters: 5000, excludeDriverIds: [] });
  });

  // L3-08 (24 août) : le serveur exclut ces identifiants et élargit le rayon si besoin
  // (nearby/expand.ts) -- l'écran ne fait que les rappeler, jamais de décision ici.
  it('transmet les chauffeurs déjà refusés au serveur, pour élargissement (L3-08)', async () => {
    await renderQuote({ nearbyDrivers: [driver({ driverId: 'still-here' })], excludedDriverIds: ['refused-1', 'refused-2'] });

    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', {
      position: ORIGIN.position,
      radiusMeters: 5000,
      excludeDriverIds: ['refused-1', 'refused-2'],
    });
  });

  it('un chauffeur qui devient indisponible pendant la comparaison disparaît de la liste, avant toute sélection', async () => {
    const stillThere = driver({ driverId: 'still-there', firstName: 'Aminata' });
    const { root } = await renderQuote({ nearbyDrivers: [driver({ driverId: 'taken' }), stillThere] });

    expect(root.root.findByProps({ testID: 'driver-card-taken' })).toBeTruthy();

    // Le serveur retire un chauffeur réservé de nearby.drivers (L3-06, critère 3) -- la
    // diffusion suivante ne le porte plus.
    await act(async () => {
      emitNearbyDrivers([stillThere]);
    });

    expect(root.root.findAllByProps({ testID: 'driver-card-taken' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'driver-card-still-there' })).toBeTruthy();
  });

  it('une reconnexion réémet l’abonnement, la liste ne se fige jamais pendant la comparaison', async () => {
    await renderQuote();
    mockSend.mockClear();

    await act(async () => {
      connectionStateListener?.('connected');
    });

    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', { position: ORIGIN.position, radiusMeters: 5000, excludeDriverIds: [] });
  });

  it('se désabonne à la sortie de l’écran (sélection d’un chauffeur, ou retour à l’accueil)', async () => {
    const { root } = await renderQuote();

    await act(async () => {
      root.unmount();
    });
    renderedRoots.length = 0; // déjà démonté ci-dessus, afterEach ne doit pas le redémonter

    expect(mockSend).toHaveBeenCalledWith('nearby.unsubscribe', {});
  });

  it('critère 4 (L6-08) : plus aucun chauffeur disponible après exclusion -- message clair, pas de fausse attente', async () => {
    const { root } = await renderQuote({ nearbyDrivers: [driver({ driverId: 'refused' })], excludedDriverIds: ['refused'] });

    expect(root.root.findByProps({ testID: 'no-driver-available' })).toBeTruthy();
    expect(root.root.findAllByProps({ testID: 'driver-card-refused' })).toHaveLength(0);

    await act(async () => {
      root.root.findByProps({ testID: 'back-to-home' }).props.onPress();
    });
    expect(root.root.findAllByProps({ testID: 'driver-card-refused' })).toHaveLength(0);
  });

  it('une estimation en échec (ROUTE_UNAVAILABLE) affiche un message et un bouton de réessai', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') throw new ApiError('ROUTE_UNAVAILABLE', "Impossible de calculer l'itinéraire pour le moment. Réessayez.", 503);
      throw new Error('unexpected');
    });

    const { root } = await renderQuote();

    expect(root.root.findByProps({ testID: 'retry-quote' })).toBeTruthy();
    expect(texts(root)).toContain("Impossible de calculer l'itinéraire pour le moment. Réessayez.");
  });
});
