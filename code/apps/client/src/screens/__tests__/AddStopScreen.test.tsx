import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { LatLng } from '@babana/maps';
import { ApiError } from '@babana/api-client';
import { asRideId } from '@babana/navigation';

let capturedOnRegionChange: ((point: LatLng) => Promise<void> | void) | null = null;
const mockReverseGeocode = jest.fn<Promise<string | null>, [LatLng]>();

jest.mock('@babana/maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MapView: (props: { onRegionChange?: (point: LatLng) => void }) => {
      capturedOnRegionChange = props.onRegionChange ?? null;
      return <View testID="mock-map" />;
    },
    reverseGeocode: (point: LatLng) => mockReverseGeocode(point),
    searchPlace: jest.fn(async () => []),
    MAP_MARKER_COLORS: { pickup: '#3E7BFA', dropoff: '#E5484D', stop: '#F59E0B', driver: '#1A9E5C', client: '#3E7BFA', reticle: '#6B7280' },
  };
});

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { AddStopScreen } from '../AddStopScreen';

const RIDE_ID = asRideId('ride-1');
const CENTER = { latitude: 4.05, longitude: 9.7 };
const STOP = { latitude: 4.056, longitude: 9.76 };

function quoteResponse(overrides = {}) {
  return {
    quoteId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    rideId: RIDE_ID,
    amount: 1900,
    previousAmount: 1500,
    currency: 'XAF',
    distanceMeters: 5600,
    stopCount: 1,
    breakdown: {},
    expiresAt: '2026-11-17T07:20:00Z',
    ...overrides,
  };
}

function fcfa(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

async function renderAddStop() {
  const navigation = { goBack: jest.fn(), addListener: jest.fn(() => jest.fn()), isFocused: () => true };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<AddStopScreen navigation={navigation} route={{ key: 'AddStop', name: 'AddStop', params: { rideId: RIDE_ID, center: CENTER } }} />);
  });
  roots.push(root);
  return { root, navigation };
}

async function designate() {
  await act(async () => {
    await capturedOnRegionChange?.(STOP);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReverseGeocode.mockResolvedValue('Marché, Douala');
});

describe('AddStopScreen (L6-21)', () => {
  it('rien à coter tant qu’aucun point n’est désigné', async () => {
    const { root } = await renderAddStop();
    expect(root.root.findByProps({ testID: 'add-stop-quote' }).props.disabled).toBe(true);
  });

  it('désigner, voir le prix du serveur, confirmer : deux appels, puis retour au suivi', async () => {
    mockRequest.mockImplementation(async (name: string) => (name === 'quoteAddedStop' ? quoteResponse() : { stops: [] }));
    const { root, navigation } = await renderAddStop();
    await designate();
    expect(texts(root)).toContain('vers Marché');

    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-quote' }).props.onPress();
    });
    expect(mockRequest).toHaveBeenCalledWith('quoteAddedStop', {
      pathParams: { id: RIDE_ID },
      body: { position: STOP, label: 'vers Marché' },
    });
    // Le prix vient de la cotation, jamais d'un calcul de l'app (invariant 3).
    expect(texts(root)).toContain(fcfa(1500));
    expect(texts(root)).toContain(fcfa(1900));

    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-confirm' }).props.onPress();
    });
    expect(mockRequest).toHaveBeenCalledWith('confirmAddedStop', {
      pathParams: { id: RIDE_ID },
      body: { quoteId: quoteResponse().quoteId },
    });
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it('un nouveau point désigné après la cotation l’annule : il faut recoter', async () => {
    mockRequest.mockResolvedValue(quoteResponse());
    const { root } = await renderAddStop();
    await designate();
    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-quote' }).props.onPress();
    });
    await designate();
    expect(root.root.findAllByProps({ testID: 'add-stop-confirm' })).toHaveLength(0);
    expect(root.root.findAllByProps({ testID: 'add-stop-price' })).toHaveLength(0);
  });

  it('cotation expirée à la confirmation : le message, et retour à la cotation', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'quoteAddedStop') return quoteResponse();
      throw new ApiError('QUOTE_EXPIRED', 'expirée', 410);
    });
    const { root, navigation } = await renderAddStop();
    await designate();
    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-quote' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-confirm' }).props.onPress();
    });
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(root.root.findAllByProps({ testID: 'add-stop-error' }).length).toBeGreaterThan(0);
    expect(root.root.findAllByProps({ testID: 'add-stop-quote' }).length).toBeGreaterThan(0);
  });

  it('trop d’arrêts : le refus du serveur est dit, rien n’est ajouté', async () => {
    mockRequest.mockRejectedValue(new ApiError('TOO_MANY_STOPS', 'trop', 400));
    const { root } = await renderAddStop();
    await designate();
    await act(async () => {
      root.root.findByProps({ testID: 'add-stop-quote' }).props.onPress();
    });
    expect(texts(root)).toContain('Trop d');
    expect(root.root.findAllByProps({ testID: 'add-stop-confirm' })).toHaveLength(0);
  });
});
