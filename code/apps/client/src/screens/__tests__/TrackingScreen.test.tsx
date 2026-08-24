import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asDriverId, asRideId } from '@babana/navigation';

jest.mock('@babana/maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MapView: () => <View testID="mock-map" />,
  };
});

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

jest.mock('../../location', () => ({
  getCurrentPosition: jest.fn().mockResolvedValue({ status: 'success', position: { latitude: 4.05, longitude: 9.7 } }),
}));

jest.mock('../../incidentQueue', () => {
  const { PendingIncidentQueue, createInMemoryPendingIncidentQueue } = jest.requireActual('@babana/api-client');
  return { pendingIncidentQueue: new PendingIncidentQueue(createInMemoryPendingIncidentQueue()) };
});

let realtimeListener: ((message: unknown) => void) | null = null;
let connectionStateListener: ((state: string) => void) | null = null;
const mockSend = jest.fn();
const mockEnsureConnected = jest.fn();
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
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
  realtimeClient: {
    send: (...args: unknown[]) => mockSend(...args),
    getState: () => mockConnectionState,
  },
}));

import { TrackingScreen } from '../TrackingScreen';

const RIDE_ID = asRideId('ride-1');
const DRIVER_ID = asDriverId('driver-1');
const ORIGIN = { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' };
const DESTINATION = { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' };
const DRIVER = {
  driverId: DRIVER_ID,
  firstName: 'Paul',
  photoUrl: null,
  motorcycleClass: 'standard' as const,
  licensePlate: 'LT-1234-AB',
};

function fakeNavigation() {
  return { navigate: jest.fn(), replace: jest.fn(), reset: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderTracking(
  overrides: { origin?: typeof ORIGIN; destination?: typeof DESTINATION; driver?: typeof DRIVER } = {},
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'Tracking',
    name: 'Tracking' as const,
    params: {
      rideId: RIDE_ID,
      origin: overrides.origin ?? ORIGIN,
      destination: overrides.destination ?? DESTINATION,
      driver: overrides.driver ?? DRIVER,
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<TrackingScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

function emitPosition(overrides: Partial<{ rideId: string; latitude: number; longitude: number; etaSeconds: number }> = {}) {
  realtimeListener?.({
    type: 'driver.position',
    id: 'm1',
    emittedAt: new Date().toISOString(),
    payload: {
      rideId: overrides.rideId ?? RIDE_ID,
      position: { latitude: overrides.latitude ?? 4.051, longitude: overrides.longitude ?? 9.701 },
      etaSeconds: overrides.etaSeconds ?? 300,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  connectionStateListener = null;
  mockConnectionState = 'connected';
});

describe('TrackingScreen (L6-09)', () => {
  it("s'abonne à ride.track au montage", async () => {
    await renderTracking();

    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('ride.track', { rideId: RIDE_ID });
  });

  it('critère 1 : immatriculation et gamme sont visibles pendant l’approche', async () => {
    const { root } = await renderTracking();

    expect(texts(root)).toContain('LT-1234-AB');
    expect(texts(root)).toContain('Standard');
    expect(texts(root)).toContain('Paul');
  });

  it("l'ETA de driver.position est affiché pendant l'approche", async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition({ etaSeconds: 300 });
    });

    expect(root.root.findByProps({ testID: 'tracking-eta' })).toBeTruthy();
    expect(texts(root)).toContain('≈ 5 min');
  });

  it("l'ETA disparaît une fois la course démarrée -- il ne cible que le point de prise en charge, jamais la destination", async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition({ etaSeconds: 300 });
    });
    expect(root.root.findByProps({ testID: 'tracking-eta' })).toBeTruthy();

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });

    expect(root.root.findAllByProps({ testID: 'tracking-eta' })).toHaveLength(0);
    expect(texts(root)).toContain('Course en cours');
  });

  it('ride.completed remplace la pile vers le résumé, avec exactement ce que le serveur a écrit', async () => {
    const { navigation } = await renderTracking();

    const breakdown = {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    };
    await act(async () => {
      realtimeListener?.({
        type: 'ride.completed',
        id: 'm3',
        emittedAt: new Date().toISOString(),
        payload: { rideId: RIDE_ID, distanceMeters: 4200, durationSeconds: 780, amount: 1200, breakdown },
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('RideSummary', {
      rideId: RIDE_ID,
      distanceMeters: 4200,
      durationSeconds: 780,
      amount: 1200,
      breakdown,
    });
  });

  it('un message pour une autre course est ignoré', async () => {
    const { root, navigation } = await renderTracking();

    await act(async () => {
      emitPosition({ rideId: 'another-ride' });
    });

    expect(root.root.findByProps({ testID: 'tracking-map' })).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('critère 3 : la perte de connexion est signalée explicitement, jamais une position figée qu’on croirait à jour', async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition();
    });
    expect(root.root.findAllByProps({ testID: 'tracking-connection-banner' })).toHaveLength(0);

    await act(async () => {
      connectionStateListener?.('offline');
    });

    expect(root.root.findByProps({ testID: 'tracking-connection-banner' })).toBeTruthy();
    expect(texts(root)).toContain('Connexion perdue');
  });

  it('une reconnexion réémet ride.track', async () => {
    await renderTracking();
    mockSend.mockClear();

    await act(async () => {
      connectionStateListener?.('connected');
    });

    expect(mockSend).toHaveBeenCalledWith('ride.track', { rideId: RIDE_ID });
  });

  // L8-03/L8-04 (24 août) : partage de trajet et bouton d'urgence, tous deux atteignables en un
  // geste depuis cet écran -- ni l'un ni l'autre n'est plus absent (précédent commentaire).
  it('le partage de trajet et le bouton d’urgence sont tous deux atteignables depuis l’écran de suivi', async () => {
    const { root } = await renderTracking();

    expect(root.root.findAllByProps({ testID: 'share-trip-button' }).length).toBeGreaterThan(0);
    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);
  });

  it('le bouton d’urgence reste atteignable pendant l’approche comme pendant la course', async () => {
    const { root } = await renderTracking();
    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });

    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);
  });
});
