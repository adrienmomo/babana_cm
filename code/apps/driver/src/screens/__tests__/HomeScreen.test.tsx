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
const mockSend = jest.fn();
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
  // getState/send : AvailabilityToggle.tsx (montée par cet écran) en a besoin aussi -- même
  // module, même mock (jest.mock s'applique une fois par chemin de module).
  realtimeClient: { getState: () => mockConnectionState, send: (...args: unknown[]) => mockSend(...args) },
}));

// L6-05 : AvailabilityToggle.tsx (montée par cet écran) importe le singleton réel sinon -- voir
// components/__tests__/AvailabilityToggle.test.tsx pour le même raisonnement.
jest.mock('../../location', () => ({
  locationTracker: { setOnline: jest.fn() },
}));

import { HomeScreen } from '../HomeScreen';
import { resetProposalDedup } from '../../proposalDedup';

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

function emitSessionSynced(
  activeRideState: string | null,
  activeProposal: Record<string, unknown> | null = null
) {
  realtimeListener?.({
    type: 'session.synced',
    id: 's1',
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: activeRideState ? 'r1' : null,
      activeRideState,
      activeProposal,
      serverTime: new Date().toISOString(),
    },
  });
}

function anActiveProposal(rideId = 'ride-resync') {
  return {
    rideId,
    origin: { latitude: 4.05, longitude: 9.7 },
    destination: { latitude: 4.06, longitude: 9.71 },
    amount: 1500,
    distanceMeters: 2400,
    distanceToOriginMeters: 700,
    expiresAt: new Date(Date.now() + 6_000).toISOString(),
    emittedAt: new Date(Date.now() - 24_000).toISOString(),
  };
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
      distanceToOriginMeters: 1200,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  connectionStateListener = null;
  mockConnectionState = 'offline';
  resetProposalDedup();
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
      expect.objectContaining({ rideId: 'ride-42', amount: 1200, distanceMeters: 3000, distanceToOriginMeters: 1200 })
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

  it('proposal.new est ouvert en mode realtime avec emittedAt (pour proposal.seen, L7-04)', async () => {
    const { navigation } = await renderHome();

    await act(async () => {
      emitProposal('ride-77');
    });

    expect(navigation.navigate).toHaveBeenCalledWith(
      'Proposal',
      expect.objectContaining({ source: 'realtime', rideId: 'ride-77', emittedAt: expect.any(String) })
    );
  });

  it('L7-04 -- une proposition active retrouvée dans session.synced.activeProposal ouvre l’écran (app relancée / reconnexion)', async () => {
    const { navigation } = await renderHome();
    const active = anActiveProposal('ride-resync');

    await act(async () => {
      emitSessionSynced(null, active);
    });

    expect(navigation.navigate).toHaveBeenCalledWith(
      'Proposal',
      expect.objectContaining({
        source: 'realtime',
        rideId: 'ride-resync',
        amount: 1500,
        expiresAt: active.expiresAt,
        emittedAt: active.emittedAt,
      })
    );
  });

  it("L7-04 -- session.synced sans activeProposal n'ouvre aucun écran (l'absence est un fait, pas un silence)", async () => {
    const { navigation } = await renderHome();

    await act(async () => {
      emitSessionSynced('assigned', null);
    });

    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('L7-04 -- déduplication : le WebSocket puis session.synced pour la même course n’ouvrent qu’un écran', async () => {
    const { navigation } = await renderHome();

    await act(async () => {
      emitProposal('ride-dup');
      emitSessionSynced(null, anActiveProposal('ride-dup'));
    });

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
  });
});
