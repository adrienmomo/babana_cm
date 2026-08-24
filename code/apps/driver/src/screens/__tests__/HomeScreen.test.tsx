import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

let realtimeListener: ((message: unknown) => void) | null = null;
let connectionStateListener: ((state: string) => void) | null = null;
const mockEnsureConnected = jest.fn();
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'offline';
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
  realtimeClient: { getState: () => mockConnectionState },
}));

import { HomeScreen } from '../HomeScreen';

function fakeNavigation() {
  return { navigate: jest.fn(), getState: jest.fn(() => ({ routes: [{ name: 'Home' }] })) };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderHome(navigation = fakeNavigation()): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = { key: 'Home', name: 'Home' as const, params: undefined };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<HomeScreen navigation={navigation} route={route} />);
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

function emitSessionSynced(activeRideState: string | null) {
  realtimeListener?.({
    type: 'session.synced',
    id: 's1',
    emittedAt: new Date().toISOString(),
    payload: { activeRideId: activeRideState ? 'r1' : null, activeRideState, serverTime: new Date().toISOString() },
  });
}

function emitProposal(rideId = 'r1') {
  realtimeListener?.({
    type: 'proposal.new',
    id: 'p1',
    emittedAt: new Date().toISOString(),
    payload: {
      rideId,
      origin: { latitude: 4.05, longitude: 9.7 },
      destination: { latitude: 4.06, longitude: 9.71 },
      amount: 1200,
      distanceMeters: 3000,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  connectionStateListener = null;
  mockConnectionState = 'offline';
});

describe('HomeScreen (L6-11)', () => {
  it("s'abonne à la connexion temps réel au montage", async () => {
    await renderHome();
    expect(mockEnsureConnected).toHaveBeenCalled();
  });

  it('critère 4 -- l’état de connexion est distinct de l’état en ligne', async () => {
    mockRequest.mockResolvedValue({ online: true });
    const { root } = await renderHome();

    expect(texts(root)).toContain('Hors connexion');

    await act(async () => {
      connectionStateListener?.('connected');
    });
    expect(texts(root)).toContain('Connexion au service établie');
    // Se mettre en ligne n'a jamais été demandé -- l'indicateur de connexion et l'état "en
    // ligne" du chauffeur restent deux choses distinctes, l'une n'implique pas l'autre.
    expect(texts(root)).toContain('Hors ligne');

    await act(async () => {
      root.root.findByProps({ testID: 'availability-toggle' }).props.onPress();
    });
    expect(texts(root)).toContain('En ligne');
    expect(texts(root)).toContain('Connexion au service établie');
  });

  it('reçoit session.synced et désactive la bascule pendant une course, sans qu\'aucune action locale ne le décide', async () => {
    const { root } = await renderHome();

    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(false);

    await act(async () => {
      emitSessionSynced('assigned');
    });
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(true);

    await act(async () => {
      emitSessionSynced(null);
    });
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(false);
  });

  it('une proposition reçue navigue vers l’écran Proposal avec son rideId', async () => {
    const { navigation } = await renderHome();

    await act(async () => {
      emitProposal('ride-42');
    });

    expect(navigation.navigate).toHaveBeenCalledWith(
      'Proposal',
      expect.objectContaining({ rideId: 'ride-42', amount: 1200, distanceMeters: 3000 })
    );
  });

  it("critère 5 (L6-12) -- une seconde proposition n'est pas ouverte par-dessus une déjà affichée", async () => {
    const navigation = fakeNavigation();
    navigation.getState.mockReturnValue({ routes: [{ name: 'Home' }, { name: 'Proposal' }] });
    await renderHome(navigation);

    await act(async () => {
      emitProposal('ride-99');
    });

    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
