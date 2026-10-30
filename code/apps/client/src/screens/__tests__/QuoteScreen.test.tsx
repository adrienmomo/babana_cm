import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// Même mock que HomeScreen.test.tsx (`../realtime` porte le WebSocket partagé de l'app) : l'écran
// ne lit plus que l'état de connexion, pour expliquer un échec de commande hors connexion.
let connectionStateListener: ((state: string) => void) | null = null;
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
jest.mock('../../realtime', () => ({
  onRealtimeConnectionStateChange: (listener: (state: string) => void) => {
    connectionStateListener = listener;
    return () => {
      connectionStateListener = null;
    };
  },
  realtimeClient: {
    getState: () => mockConnectionState,
  },
}));

function setConnectionState(state: 'offline' | 'connecting' | 'connected') {
  mockConnectionState = state;
  connectionStateListener?.(state);
}

import { QuoteScreen } from '../QuoteScreen';

const ORIGIN = { position: { latitude: 4.0511, longitude: 9.7679 }, label: 'vers Akwa, Douala' };
const DESTINATION = { position: { latitude: 4.0611, longitude: 9.7861 }, label: 'vers Bonapriso, Douala' };

function quoteResponse(overrides: Partial<http.QuoteResponse> = {}): http.QuoteResponse {
  return {
    quoteId: '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c',
    amount: 1200,
    currency: 'XAF',
    breakdown: {
      baseFare: 200,
      approachFare: 0,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    },
    distanceMeters: 4200,
    approachDistanceMeters: 1500,
    etaSeconds: 780,
    pickupEtaSeconds: 180,
    promoApplied: false,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    validForSeconds: 300,
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
  } = {},
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'Quote',
    name: 'Quote' as const,
    params: {
      origin: params.origin ?? ORIGIN,
      destination: params.destination ?? DESTINATION,
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
  connectionStateListener = null;
  mockConnectionState = 'connected';
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

  it('la prise en charge (approche moyenne) et le forfait sont deux lignes distinctes, avant « Commander »', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') {
        return quoteResponse({
          amount: 1275,
          breakdown: { ...quoteResponse().breakdown, baseFare: 200, approachFare: 75, distanceFare: 1000 },
        });
      }
      throw new Error('unexpected');
    });

    const { root } = await renderQuote();

    expect(texts(root)).toContain(fcfa(1275));
    expect(texts(root)).toContain('Prise en charge');
    expect(texts(root)).toContain(fcfa(75));
    expect(texts(root)).toContain('Forfait');
    expect(texts(root)).toContain(fcfa(200));
    expect(root.root.findByProps({ testID: 'order-button' }).props.disabled).toBe(false);
  });

  it('les composantes non nulles du détail somment exactement le total affiché', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') {
        return quoteResponse({
          amount: 1450,
          breakdown: {
            baseFare: 200,
            approachFare: 0,
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

  it("la validité se compte depuis la réception, jamais avec l'horloge du téléphone", async () => {
    // Horloge du téléphone en retard d'un jour (cas réel, 26 octobre) : `expiresAt` paraît alors à
    // 24 h dans le futur. La validité affichée reste celle envoyée par le serveur.
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') {
        return quoteResponse({ expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), validForSeconds: 300 });
      }
      throw new Error('unexpected');
    });
    jest.useFakeTimers();
    const { root } = await renderQuote();

    expect(JSON.stringify(root.root.findByProps({ testID: 'quote-validity' }).props.children)).toContain('5');
    await act(async () => {
      jest.advanceTimersByTime(6 * 60_000);
    });
    expect(root.root.findByProps({ testID: 'refresh-quote' })).toBeTruthy();
    jest.useRealTimers();
  });

  it('« Moto à ~N min » et le paiement en espèces sont visibles avant de commander', async () => {
    const { root } = await renderQuote();

    expect(texts(root)).toContain('Moto à ≈ 3 min');
    expect(texts(root)).toContain('Paiement en espèces au chauffeur');
  });

  it('personne à proximité : le client le sait avant de commander', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quote') return quoteResponse({ pickupEtaSeconds: null });
      throw new Error('unexpected');
    });
    const { root } = await renderQuote();

    expect(texts(root)).toContain('Aucune moto à proximité pour le moment');
    expect(root.root.findByProps({ testID: 'order-button' }).props.disabled).toBe(false);
  });

  describe('indication pour le chauffeur (repère, facultatif)', () => {
    function mockOrderFlow() {
      mockRequest.mockImplementation(async (name: string) => {
        if (name === 'quote') return quoteResponse();
        if (name === 'createRide') return { id: 'ride-1', state: 'requested', amount: 1200 };
        throw new Error(`unexpected call: ${name}`);
      });
    }

    it('un repère saisi part avec la commande, sans les espaces de bord', async () => {
      mockOrderFlow();
      const { root } = await renderQuote();

      const input = root.root.findByProps({ testID: 'pickup-note-input' });
      expect(input.props.maxLength).toBe(140);
      await act(async () => {
        input.props.onChangeText('  Devant la pharmacie du rond-point ');
      });
      await act(async () => {
        root.root.findByProps({ testID: 'order-button' }).props.onPress();
      });

      expect(mockRequest).toHaveBeenCalledWith(
        'createRide',
        expect.objectContaining({ body: { quoteId: quoteResponse().quoteId, pickupNote: 'Devant la pharmacie du rond-point' } })
      );
    });

    it('un repère vide (ou fait d’espaces) n’est pas envoyé', async () => {
      mockOrderFlow();
      const { root } = await renderQuote();
      await act(async () => {
        root.root.findByProps({ testID: 'pickup-note-input' }).props.onChangeText('   ');
      });
      await act(async () => {
        root.root.findByProps({ testID: 'order-button' }).props.onPress();
      });
      expect(mockRequest).toHaveBeenCalledWith('createRide', expect.objectContaining({ body: { quoteId: quoteResponse().quoteId } }));
    });
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

  describe('commande -- le chauffeur est choisi par le serveur, jamais par le client', () => {
    it("aucun chauffeur n'est proposé au choix : un seul bouton « Commander »", async () => {
      const { root } = await renderQuote();
      const choosable = root.root.findAll(
        (node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('driver-card')
      );
      expect(choosable).toHaveLength(0);
      expect(root.root.findByProps({ testID: 'order-button' })).toBeTruthy();
    });

    it("« Commander » crée la course puis remplace la pile par l'attente, où la recherche démarre (L6-00)", async () => {
      mockRequest.mockImplementation(async (name: string) => {
        if (name === 'quote') return quoteResponse();
        if (name === 'createRide') return { id: 'ride-1', state: 'requested', amount: 1200 };
        throw new Error(`unexpected call: ${name}`);
      });
      const { root, navigation } = await renderQuote();

      await act(async () => {
        root.root.findByProps({ testID: 'order-button' }).props.onPress();
      });

      expect(mockRequest).toHaveBeenCalledWith('createRide', expect.anything());
      expect(mockRequest).not.toHaveBeenCalledWith('dispatchRide', expect.anything());
      expect(navigation.reset).toHaveBeenCalledWith({
        index: 0,
        routes: [
          {
            name: 'Waiting',
            params: expect.objectContaining({ rideId: 'ride-1', amount: 1200, origin: ORIGIN, destination: DESTINATION }),
          },
        ],
      });
    });

    it("tant que l'estimation n'est pas là, ou a expiré, on ne peut pas commander", async () => {
      jest.useFakeTimers();
      const { root } = await renderQuote();
      await act(async () => {
        jest.advanceTimersByTime(6 * 60_000);
      });
      expect(root.root.findByProps({ testID: 'order-button' }).props.disabled).toBe(true);
      jest.useRealTimers();
    });

    it('L6-16 -- hors connexion, la commande échoue avec une explication précise, jamais mise en file', async () => {
      mockRequest.mockImplementation(async (name: string) => {
        if (name === 'quote') return quoteResponse();
        throw new TypeError('Network request failed');
      });
      const { root } = await renderQuote();
      await act(async () => {
        setConnectionState('offline');
      });

      await act(async () => {
        root.root.findByProps({ testID: 'order-button' }).props.onPress();
      });

      expect(texts(root)).toContain('Hors connexion');
    });
  });

});
