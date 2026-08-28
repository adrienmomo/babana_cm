import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asDriverId, asRideId } from '@babana/navigation';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

let realtimeListener: ((message: unknown) => void) | null = null;
const mockEnsureConnected = jest.fn();
jest.mock('../../realtime', () => ({
  ensureRealtimeConnected: () => mockEnsureConnected(),
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
}));

import { WaitingScreen } from '../WaitingScreen';

const RIDE_ID = asRideId('ride-1');
const DRIVER_ID = asDriverId('driver-1');

const SELECTION = {
  origin: { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' },
  destination: { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' },
  nearbyDrivers: [],
  excludedDriverIds: [],
  rejectionStreak: 0,
  rideId: RIDE_ID,
};

function fakeNavigation() {
  return { navigate: jest.fn(), replace: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderWaiting(navigation = fakeNavigation()): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'Waiting',
    name: 'Waiting' as const,
    params: {
      rideId: RIDE_ID,
      driverId: DRIVER_ID,
      proposalExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      amount: 1200,
      selectedAt: Date.now(),
      selection: SELECTION,
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<WaitingScreen navigation={navigation} route={route} />);
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

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
});

describe('WaitingScreen (L6-08)', () => {
  it("s'abonne au temps réel et affiche le montant et un compte à rebours indicatif", async () => {
    const { root } = await renderWaiting();

    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'waiting-countdown' })).toBeTruthy();
  });

  it('ride.assigned remplace la pile vers le suivi de course, avec le cliché du chauffeur affecté', async () => {
    const { navigation } = await renderWaiting();

    await act(async () => {
      realtimeListener?.({
        type: 'ride.assigned',
        id: 'm1',
        emittedAt: new Date().toISOString(),
        payload: {
          rideId: RIDE_ID,
          driverId: DRIVER_ID,
          firstName: 'Paul',
          photoUrl: null,
          motorcycleClass: 'standard',
          licensePlate: 'LT-1234-AB',
          phoneNumber: '+237691234567',
        },
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('Tracking', {
      rideId: RIDE_ID,
      origin: SELECTION.origin,
      destination: SELECTION.destination,
      driver: {
        driverId: DRIVER_ID,
        firstName: 'Paul',
        photoUrl: null,
        motorcycleClass: 'standard',
        licensePlate: 'LT-1234-AB',
        phoneNumber: '+237691234567',
      },
    });
  });

  it('ride.rejected pour cette course navigue vers DriverRejected avec le motif et le chauffeur concernés', async () => {
    const { navigation } = await renderWaiting();

    await act(async () => {
      realtimeListener?.({
        type: 'ride.rejected',
        id: 'm1',
        emittedAt: new Date().toISOString(),
        payload: { rideId: RIDE_ID, driverId: DRIVER_ID, reason: 'driver_timeout' },
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('DriverRejected', {
      rideId: RIDE_ID,
      driverId: DRIVER_ID,
      reason: 'driver_timeout',
      selection: SELECTION,
    });
  });

  it('un ride.rejected pour une autre course est ignoré', async () => {
    const { navigation } = await renderWaiting();

    await act(async () => {
      realtimeListener?.({
        type: 'ride.rejected',
        id: 'm1',
        emittedAt: new Date().toISOString(),
        payload: { rideId: asRideId('another-ride'), driverId: DRIVER_ID, reason: 'driver_rejected' },
      });
    });

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('« Annuler » annule la course, instrumente l’abandon et revient à l’accueil', async () => {
    mockRequest.mockResolvedValue({ id: 'ride-1', state: 'cancelled' });
    const { root, navigation } = await renderWaiting();

    await act(async () => {
      root.root.findByProps({ testID: 'cancel-waiting' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('cancelRide', expect.objectContaining({ pathParams: { id: RIDE_ID } }));
    expect(navigation.navigate).toHaveBeenCalledWith('Home');
  });

  it("un échec de l'annulation affiche un message, sans quitter l'écran", async () => {
    const { ApiError } = jest.requireActual('@babana/api-client');
    mockRequest.mockRejectedValue(new ApiError('RIDE_NOT_FOUND', "Cette course n'existe pas ou n'est plus disponible.", 404));
    const { root, navigation } = await renderWaiting();

    await act(async () => {
      root.root.findByProps({ testID: 'cancel-waiting' }).props.onPress();
    });

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'cancel-waiting' }).props.disabled).toBe(false);
    expect(texts(root)).toContain("Cette course n'existe pas ou n'est plus disponible.");
  });
});
