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
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
jest.mock('../../realtime', () => ({
  ensureRealtimeConnected: () => mockEnsureConnected(),
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  realtimeClient: { getState: () => mockConnectionState },
}));

const mockReportMetric = jest.fn();
jest.mock('@babana/api-client', () => ({
  ...jest.requireActual('@babana/api-client'),
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

import { ApiError } from '@babana/api-client';
import { WaitingScreen } from '../WaitingScreen';

const RIDE_ID = asRideId('ride-1');
const DRIVER_ID = asDriverId('driver-1');
const ORIGIN = { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' };
const DESTINATION = { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' };

const PROPOSED = {
  id: RIDE_ID,
  state: 'proposed',
  amount: 1200,
  currency: 'XAF',
  assignedDriverId: DRIVER_ID,
  proposalExpiresAt: new Date(Date.now() + 30_000).toISOString(),
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

async function renderWaiting(navigation = fakeNavigation()) {
  const route = {
    key: 'Waiting',
    name: 'Waiting' as const,
    params: { rideId: RIDE_ID, amount: 1200, origin: ORIGIN, destination: DESTINATION, requestedAt: Date.now() },
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

function shown(root: ReactTestRenderer, testID: string): boolean {
  return root.root.findAll((node) => node.props.testID === testID).length > 0;
}

function emit(type: string, payload: Record<string, unknown>) {
  realtimeListener?.({ type, id: 'm1', emittedAt: new Date().toISOString(), payload });
}

function dispatchCalls() {
  return mockRequest.mock.calls.filter(([name]) => name === 'dispatchRide');
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  mockConnectionState = 'connected';
  mockRequest.mockImplementation(async (name: string) => {
    if (name === 'dispatchRide') return PROPOSED;
    if (name === 'cancelRide') return { id: RIDE_ID, state: 'cancelled' };
    throw new Error(`unexpected call: ${name}`);
  });
});

describe('WaitingScreen -- la course part au chauffeur le plus proche, choisi par le serveur', () => {
  it('lance la recherche dès l’ouverture, une seule fois, sans désigner de chauffeur', async () => {
    await renderWaiting();

    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(dispatchCalls()).toHaveLength(1);
    expect(mockRequest).toHaveBeenCalledWith('dispatchRide', { pathParams: { id: RIDE_ID }, body: {} });
  });

  it('une fois la demande transmise, le dit sans nommer le chauffeur', async () => {
    const { root } = await renderWaiting();

    expect(texts(root)).toContain('Un chauffeur proche a reçu votre demande');
    expect(texts(root)).not.toContain('driver-1');
  });

  it('ride.assigned remplace la pile vers le suivi de course, avec le cliché du chauffeur affecté', async () => {
    const { navigation } = await renderWaiting();

    await act(async () => {
      emit('ride.assigned', {
        rideId: RIDE_ID,
        driverId: DRIVER_ID,
        firstName: 'Paul',
        photoUrl: null,
        motorcycleClass: 'standard',
        licensePlate: 'LT-1234-AB',
        phoneNumber: '+237691234567',
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('Tracking', {
      rideId: RIDE_ID,
      origin: ORIGIN,
      destination: DESTINATION,
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

  it('un refus ne renvoie pas le client choisir : le serveur sollicite le suivant, l’écran le dit', async () => {
    const { root, navigation } = await renderWaiting();

    await act(async () => {
      emit('ride.rejected', { rideId: RIDE_ID, driverId: DRIVER_ID, reason: 'driver_rejected' });
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(texts(root)).toContain("Ce chauffeur n'est pas disponible");
    expect(texts(root)).toContain("Recherche d'un autre chauffeur");
    expect(dispatchCalls()).toHaveLength(1);
  });

  it('une absence de réponse est dite autrement qu’un refus', async () => {
    const { root } = await renderWaiting();

    await act(async () => {
      emit('ride.rejected', { rideId: RIDE_ID, driverId: DRIVER_ID, reason: 'driver_timeout' });
    });

    expect(texts(root)).toContain("Ce chauffeur n'a pas répondu");
  });

  it('les messages d’une autre course sont ignorés', async () => {
    const { root, navigation } = await renderWaiting();

    await act(async () => {
      emit('ride.rejected', { rideId: 'another-ride', driverId: DRIVER_ID, reason: 'driver_rejected' });
      emit('ride.unmatched', { rideId: 'another-ride' });
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(shown(root, 'retry-dispatch')).toBe(false);
  });

  describe('aucun chauffeur disponible', () => {
    it('personne à proximité dès la commande : le dire, proposer Réessayer et Annuler', async () => {
      mockRequest.mockImplementation(async (name: string) => {
        if (name === 'dispatchRide') throw new ApiError('NO_DRIVER_AVAILABLE', 'x', 404);
        throw new Error(`unexpected call: ${name}`);
      });
      const { root } = await renderWaiting();

      expect(texts(root)).toContain("Aucun chauffeur n'est disponible pour le moment.");
      expect(shown(root, 'retry-dispatch')).toBe(true);
      expect(shown(root, 'cancel-waiting')).toBe(true);
    });

    it('après les tentatives automatiques (ride.unmatched) : même choix', async () => {
      const { root } = await renderWaiting();

      await act(async () => {
        emit('ride.unmatched', { rideId: RIDE_ID });
      });

      expect(texts(root)).toContain("Aucun chauffeur n'est disponible pour le moment.");
      expect(shown(root, 'retry-dispatch')).toBe(true);
    });

    it('« Réessayer » relance la recherche sur la même course', async () => {
      const { root } = await renderWaiting();
      await act(async () => {
        emit('ride.unmatched', { rideId: RIDE_ID });
      });

      await act(async () => {
        root.root.findByProps({ testID: 'retry-dispatch' }).props.onPress();
      });

      expect(dispatchCalls()).toHaveLength(2);
      expect(texts(root)).toContain('Un chauffeur proche a reçu votre demande');
      expect(shown(root, 'retry-dispatch')).toBe(false);
    });

    it('une reconnexion qui trouve la course « rejected » montre aussi le choix -- le message a pu être manqué', async () => {
      const { root } = await renderWaiting();

      await act(async () => {
        emit('session.synced', {
          activeRideId: RIDE_ID,
          activeRideState: 'rejected',
          rideStateKnown: true,
          activeProposal: null,
          serverTime: new Date().toISOString(),
        });
      });

      expect(shown(root, 'retry-dispatch')).toBe(true);
    });
  });

  it('une recherche déjà en cours (écran rouvert) n’est pas une erreur', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'dispatchRide') throw new ApiError('RIDE_INVALID_TRANSITION', 'x', 409);
      throw new Error(`unexpected call: ${name}`);
    });
    const { root } = await renderWaiting();

    expect(texts(root)).toContain('Un chauffeur proche a reçu votre demande');
    expect(shown(root, 'retry-dispatch')).toBe(false);
  });

  it('hors connexion, la recherche échoue avec une explication et se relance à la main', async () => {
    mockConnectionState = 'offline';
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'dispatchRide') throw new TypeError('Network request failed');
      throw new Error(`unexpected call: ${name}`);
    });
    const { root } = await renderWaiting();

    expect(texts(root)).toContain('Hors connexion');
    expect(shown(root, 'retry-dispatch')).toBe(true);
  });

  it('« Annuler » annule la course, instrumente l’abandon avec le nombre de refus, et revient à l’accueil', async () => {
    const { root, navigation } = await renderWaiting();
    await act(async () => {
      emit('ride.rejected', { rideId: RIDE_ID, driverId: DRIVER_ID, reason: 'driver_rejected' });
    });

    await act(async () => {
      root.root.findByProps({ testID: 'cancel-waiting' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('cancelRide', expect.objectContaining({ pathParams: { id: RIDE_ID } }));
    expect(mockReportMetric).toHaveBeenCalledWith('client.ride_abandoned', expect.objectContaining({ rejectionStreak: 1 }));
    expect(navigation.navigate).toHaveBeenCalledWith('Home');
  });

  it("un échec de l'annulation affiche un message, sans quitter l'écran", async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'dispatchRide') return PROPOSED;
      throw new ApiError('RIDE_NOT_FOUND', "Cette course n'existe pas ou n'est plus disponible.", 404);
    });
    const { root, navigation } = await renderWaiting();

    await act(async () => {
      root.root.findByProps({ testID: 'cancel-waiting' }).props.onPress();
    });

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'cancel-waiting' }).props.disabled).toBe(false);
    expect(texts(root)).toContain("Cette course n'existe pas ou n'est plus disponible.");
  });
});
