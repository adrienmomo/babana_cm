import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { LatLng, PlaceResult } from '@babana/maps';
import type { http } from '@babana/contracts';

let capturedOnRegionChange: ((point: LatLng) => void) | null = null;
const mockReverseGeocode = jest.fn<Promise<string | null>, [LatLng]>();
const mockSearchPlace = jest.fn<Promise<PlaceResult[]>, [string]>();

jest.mock('@babana/maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MapView: (props: { onRegionChange?: (point: LatLng) => void }) => {
      capturedOnRegionChange = props.onRegionChange ?? null;
      return <View testID="mock-map" />;
    },
    reverseGeocode: (point: LatLng) => mockReverseGeocode(point),
    searchPlace: (query: string) => mockSearchPlace(query),
  };
});

const mockGetCurrentPosition = jest.fn<Promise<LatLng | null>, []>();
jest.mock('../../location', () => ({
  getCurrentPosition: () => mockGetCurrentPosition(),
}));

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

import { HomeScreen } from '../HomeScreen';

const DOUALA = { latitude: 4.0511, longitude: 9.7679 };
const ELSEWHERE = { latitude: 4.07, longitude: 9.72 };
const CLIENT_GPS = { latitude: 4.06, longitude: 9.71 };

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

function emitNearbyDrivers(drivers: http.NearbyDriver[]) {
  realtimeListener?.({ type: 'nearby.drivers', id: 'm1', emittedAt: new Date().toISOString(), payload: { drivers } });
}

function fakeNavigation() {
  return { navigate: jest.fn() };
}

async function renderHome(navigation = fakeNavigation()): Promise<ReactTestRenderer> {
  const route = { key: 'Home', name: 'Home' as const, params: undefined };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran (seul navigate() est utilisé)
    root = create(<HomeScreen navigation={navigation} route={route} />);
  });
  return root;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function designate(root: ReactTestRenderer, slotTestID: string, point: LatLng) {
  await act(async () => {
    root.root.findByProps({ testID: slotTestID }).props.onPress();
  });
  await act(async () => {
    await capturedOnRegionChange?.(point);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnRegionChange = null;
  realtimeListener = null;
  connectionStateListener = null;
  mockGetCurrentPosition.mockResolvedValue(null);
  mockReverseGeocode.mockResolvedValue(null);
  mockSearchPlace.mockResolvedValue([]);
});

describe('HomeScreen (L6-06)', () => {
  it('critère 2 : la désignation sur carte seule (sans jamais toucher la recherche) suffit à activer "Suivant"', async () => {
    mockReverseGeocode.mockResolvedValueOnce('Akwa, Douala').mockResolvedValueOnce('Bonapriso, Douala');
    const navigation = fakeNavigation();
    const root = await renderHome(navigation);

    await designate(root, 'departure-slot', DOUALA);
    await designate(root, 'arrival-slot', ELSEWHERE);

    expect(texts(root)).toContain('Akwa, Douala');
    expect(texts(root)).toContain('Bonapriso, Douala');
    expect(mockSearchPlace).not.toHaveBeenCalled();

    const next = root.root.findByProps({ testID: 'next-button' });
    expect(next.props.disabled).toBe(false);

    await act(async () => {
      root.root.findByProps({ testID: 'next-button' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Quote', {
      origin: { position: DOUALA, label: 'Akwa, Douala' },
      destination: { position: ELSEWHERE, label: 'Bonapriso, Douala' },
    });
  });

  it('« Suivant » reste désactivé tant que le départ et l’arrivée ne sont pas tous deux désignés', async () => {
    const root = await renderHome();

    expect(root.root.findByProps({ testID: 'next-button' }).props.disabled).toBe(true);

    await designate(root, 'departure-slot', DOUALA);

    expect(root.root.findByProps({ testID: 'next-button' }).props.disabled).toBe(true);
  });

  it('critère 1 : la recherche textuelle désigne aussi un point (second moyen, complémentaire)', async () => {
    mockSearchPlace.mockResolvedValue([{ label: 'Bonanjo, Douala', position: { latitude: 4.05, longitude: 9.69 } }]);
    const root = await renderHome();

    await act(async () => {
      root.root.findByProps({ accessibilityLabel: 'Rechercher le point de départ' }).props.onChangeText('Bonanjo');
    });
    // PlacePicker débounce la recherche (400 ms) -- attente réelle, ce composant n'expose pas
    // d'injection de temporisation à HomeScreen.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    expect(mockSearchPlace).toHaveBeenCalledWith('Bonanjo');
    expect(texts(root)).toContain('Bonanjo, Douala');
  });

  it('critère 3 : les chauffeurs se mettent à jour en direct, sans rechargement de l’écran', async () => {
    const root = await renderHome();
    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));

    await act(async () => {
      emitNearbyDrivers([driver({ driverId: 'a', firstName: 'Paul' })]);
    });
    expect(texts(root)).toContain('Paul');

    await act(async () => {
      emitNearbyDrivers([driver({ driverId: 'b', firstName: 'Aminata' })]);
    });
    expect(texts(root)).toContain('Aminata');
    expect(texts(root)).not.toContain('Paul');
  });

  it("une reconnexion (coupure réseau puis retour) réémet l'abonnement -- la liste ne se fige jamais", async () => {
    await renderHome();
    mockSend.mockClear();

    await act(async () => {
      connectionStateListener?.('connected');
    });

    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));
  });

  it("critère 4 : l'absence de chauffeur affiche un message clair et une action, pas une erreur", async () => {
    const root = await renderHome();

    await act(async () => {
      emitNearbyDrivers([]);
    });

    expect(texts(root)).toContain('Aucun chauffeur disponible pour l’instant.');
    expect(root.root.findByProps({ testID: 'retry-nearby' })).toBeTruthy();

    await act(async () => {
      root.root.findByProps({ testID: 'retry-nearby' }).props.onPress();
    });
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.anything());
  });

  it('le départ est pré-rempli avec la position courante quand la permission est accordée', async () => {
    mockGetCurrentPosition.mockResolvedValue(CLIENT_GPS);
    mockReverseGeocode.mockResolvedValue('Bonamoussadi, Douala');

    const root = await renderHome();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(texts(root)).toContain('Bonamoussadi, Douala');
  });

  it("un refus de permission n'empêche pas l'écran de s'afficher -- le départ reste à désigner à la main (D22)", async () => {
    mockGetCurrentPosition.mockResolvedValue(null);

    const root = await renderHome();
    await act(async () => {
      await Promise.resolve();
    });

    expect(texts(root)).toContain('Glissez la carte ou recherchez');
    expect(root.root.findByProps({ testID: 'mock-map' })).toBeTruthy();
  });
});
