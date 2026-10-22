import React from 'react';
import { StyleSheet, Text } from 'react-native';
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
const mockGetCurrentPosition = jest.fn();
let fixListener: ((fix: { latitude: number; longitude: number }) => void) | null = null;
jest.mock('../../location', () => ({
  locationTracker: {
    setOnline: jest.fn(),
    getState: () => 'offline',
    subscribeFix: (listener: (fix: { latitude: number; longitude: number }) => void) => {
      fixListener = listener;
      return () => {
        fixListener = null;
      };
    },
  },
  getCurrentPosition: (...args: unknown[]) => mockGetCurrentPosition(...args),
}));

// Le panneau de proposition réveille l'appareil à l'affichage (testé dans ProposalPanel.test.tsx).
jest.mock('../../proposalAlert', () => ({
  alertIncomingProposal: jest.fn(),
  dismissProposalAlert: jest.fn(),
}));

// « Encaissé aujourd'hui » du panneau du bas : lu sur GET /drivers/me/cash (`api/cash.ts`).
const mockFetchCashSummary = jest.fn();
jest.mock('../../api/cash', () => ({
  fetchCashSummary: (...args: unknown[]) => mockFetchCashSummary(...args),
}));

const mockReplaceWithSettlement = jest.fn();
jest.mock('../../navigation/transitions', () => ({
  replaceWithSettlement: (...args: unknown[]) => mockReplaceWithSettlement(...args),
}));

import { HomeScreen } from '../HomeScreen';
import { formatMoney } from '../../format';
import { resetProposalDedup } from '../../proposalDedup';
import type { ProposalParams } from '../../navigation/types';

function fakeNavigation() {
  return { navigate: jest.fn(), reset: jest.fn(), addListener: jest.fn((_event: string, _listener: () => void) => () => undefined) };
}

// Nœuds natifs seulement : `findAllByProps` compterait aussi le composant qui les rend.
const host = (root: ReactTestRenderer, testID: string) =>
  root.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
const shown = (root: ReactTestRenderer, testID: string) => host(root, testID).length > 0;

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderHome(
  navigation = fakeNavigation(),
  params: { proposal?: ProposalParams } | undefined = undefined
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = { key: 'Home', name: 'Home' as const, params };
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
  activeProposal: Record<string, unknown> | null = null,
  rideStateKnown = true
) {
  realtimeListener?.({
    type: 'session.synced',
    id: 's1',
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: activeRideState ? 'r1' : null,
      activeRideState,
      activeProposal,
      rideStateKnown,
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
  mockGetCurrentPosition.mockResolvedValue(null);
  mockFetchCashSummary.mockReset();
  mockFetchCashSummary.mockResolvedValue({ collectedToday: 0 });
  realtimeListener = null;
  connectionStateListener = null;
  fixListener = null;
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
      root.root.findByProps({ testID: 'availability-toggle' }).props.onConfirm();
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

  it("L7-04 -- session.synced avec rideStateKnown false (Odoo injoignable) ne change pas l'état de course : il n'est pas inféré d'un null", async () => {
    const { root } = await renderHome();

    await act(async () => {
      emitSessionSynced('assigned');
    });
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(true);

    // Odoo injoignable : activeRideState arrive à null, mais rideStateKnown est false -- l'app
    // garde ce qu'elle sait, la bascule reste verrouillée.
    await act(async () => {
      emitSessionSynced(null, null, false);
    });
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(true);
  });

  it('une proposition reçue s’affiche sur la carte, avec son montant — sans quitter l’écran', async () => {
    const { root, navigation } = await renderHome();

    await act(async () => {
      emitProposal('ride-42');
    });

    expect(shown(root, 'proposal-screen')).toBe(true);
    expect(texts(root)).toContain(formatMoney(1200));
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(root.root.findAllByProps({ testID: 'mock-map-view' }).length).toBeGreaterThan(0);
  });

  it('compte à rebours : l’heure du serveur portée par le message est transmise au panneau', async () => {
    // Téléphone 2 min en retard : la fenêtre de 30 s doit s'afficher 30, pas 150.
    const serverNow = Date.now() + 120_000;
    const { root } = await renderHome();
    await act(async () => {
      realtimeListener?.({
        type: 'proposal.new',
        id: 'p-skew',
        emittedAt: new Date(serverNow).toISOString(),
        payload: {
          rideId: 'ride-skew',
          origin: { latitude: 4.05, longitude: 9.7 },
          destination: { latitude: 4.06, longitude: 9.71 },
          amount: 1200,
          distanceMeters: 3000,
          distanceToOriginMeters: 1200,
          expiresAt: new Date(serverNow + 30_000).toISOString(),
          pickupNote: null,
        },
      });
    });
    const remaining = root.root.findByProps({ testID: 'countdown-value' }).props.children as number;
    expect(remaining).toBeGreaterThanOrEqual(29);
    expect(remaining).toBeLessThanOrEqual(30);
  });

  it('le repère laissé par le client s’affiche avec la proposition', async () => {
    const { root } = await renderHome();
    await act(async () => {
      realtimeListener?.({
        type: 'proposal.new',
        id: 'p-note',
        emittedAt: new Date().toISOString(),
        payload: {
          rideId: 'ride-note',
          origin: { latitude: 4.05, longitude: 9.7 },
          destination: { latitude: 4.06, longitude: 9.71 },
          amount: 1200,
          distanceMeters: 3000,
          distanceToOriginMeters: 1200,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          pickupNote: 'Devant la pharmacie du rond-point',
        },
      });
    });
    expect(texts(root)).toContain('Devant la pharmacie du rond-point');
  });

  it('Refuser / Accepter prennent la place du panneau du bas, puis celui-ci revient', async () => {
    mockConnectionState = 'connected';
    const { root } = await renderHome();
    expect(shown(root, 'home-bottom-panel')).toBe(true);

    await act(async () => {
      emitProposal('ride-swap');
    });
    expect(shown(root, 'proposal-accept')).toBe(true);
    expect(shown(root, 'proposal-reject')).toBe(true);
    expect(shown(root, 'home-bottom-panel')).toBe(false);

    await act(async () => {
      root.root.findByProps({ testID: 'proposal-reject' }).props.onPress();
    });
    expect(shown(root, 'proposal-screen')).toBe(false);
    expect(shown(root, 'home-bottom-panel')).toBe(true);
  });

  it("critère 5 (L6-12) -- une seconde proposition n'est pas ouverte par-dessus une déjà affichée", async () => {
    const { root } = await renderHome();

    await act(async () => {
      emitProposal('ride-first');
    });
    await act(async () => {
      emitProposal('ride-second');
    });

    expect(host(root, 'proposal-screen')).toHaveLength(1);
    // La seconde ne s'est pas substituée à la première.
    expect(host(root, 'proposal-accept')).toHaveLength(1);
  });

  it('L7-04 -- une proposition active retrouvée dans session.synced.activeProposal s’affiche (app relancée / reconnexion)', async () => {
    const { root } = await renderHome();

    await act(async () => {
      emitSessionSynced(null, anActiveProposal('ride-resync'));
    });

    expect(shown(root, 'proposal-screen')).toBe(true);
    expect(texts(root)).toContain(formatMoney(1500));
  });

  it("L7-04 -- session.synced sans activeProposal n'ouvre aucun panneau (l'absence est un fait, pas un silence)", async () => {
    const { root } = await renderHome();

    await act(async () => {
      emitSessionSynced('assigned', null);
    });

    expect(shown(root, 'proposal-screen')).toBe(false);
  });

  it('L7-04 -- déduplication : le WebSocket puis session.synced pour la même course n’ouvrent qu’un panneau', async () => {
    const { root } = await renderHome();

    await act(async () => {
      emitProposal('ride-dup');
      emitSessionSynced(null, anActiveProposal('ride-dup'));
    });

    expect(host(root, 'proposal-screen')).toHaveLength(1);
  });

  it('L7-04 -- l’app ouverte depuis la notification (Home: { proposal }) affiche la proposition à revalider', async () => {
    const { root } = await renderHome(fakeNavigation(), {
      proposal: { source: 'notification', rideId: 'ride-notif' as never, expiresAt: null },
    });

    expect(shown(root, 'proposal-screen')).toBe(true);
    expect(shown(root, 'proposal-revalidating')).toBe(true);
    expect(mockSend).toHaveBeenCalledWith('session.resync', { lastKnownRideId: 'ride-notif' });
  });

  describe('déroulé de la course sur la même carte', () => {
    async function acceptedRide(root: ReactTestRenderer, rideId = 'ride-flow') {
      mockConnectionState = 'connected';
      await act(async () => {
        emitProposal(rideId);
      });
      await act(async () => {
        root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
      });
      await act(async () => {
        realtimeListener?.({
          type: 'proposal.accepted',
          id: 'a1',
          emittedAt: new Date().toISOString(),
          payload: { rideId, clientPhoneNumber: '+237691234567' },
        });
      });
    }

    it("l'acceptation ouvre le panneau de course sur la carte déjà là -- aucune navigation, la carte n'est pas remontée", async () => {
      const { root, navigation } = await renderHome();
      const mapBefore = root.root.findAllByProps({ testID: 'mock-map-view' })[0];

      await acceptedRide(root);

      expect(shown(root, 'active-ride-screen')).toBe(true);
      expect(shown(root, 'proposal-screen')).toBe(false);
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(navigation.reset).not.toHaveBeenCalled();
      expect(root.root.findAllByProps({ testID: 'mock-map-view' })[0]).toBe(mapBefore);
      // Les boutons du repos ne reviennent pas pendant la course.
      expect(shown(root, 'home-bottom-panel')).toBe(false);
    });

    it('le repère du client apparaît sur la carte, avec celui du chauffeur', async () => {
      mockGetCurrentPosition.mockResolvedValue({ latitude: 4.049, longitude: 9.695 });
      const { root } = await renderHome();
      await acceptedRide(root);
      expect(host(root, 'mock-map-marker')).toHaveLength(2);
    });

    it('la position suit les relevés de la capture continue (aucun second GPS)', async () => {
      const { root } = await renderHome();
      expect(host(root, 'mock-map-marker')).toHaveLength(0);

      await act(async () => {
        fixListener?.({ latitude: 4.05, longitude: 9.7 });
      });

      expect(host(root, 'mock-map-marker')).toHaveLength(1);
    });

    it('la fin de course bascule vers le règlement', async () => {
      const { root, navigation } = await renderHome();
      await acceptedRide(root);

      await act(async () => {
        realtimeListener?.({
          type: 'ride.completed',
          id: 'c1',
          emittedAt: new Date().toISOString(),
          payload: { rideId: 'ride-flow', distanceMeters: 3300, durationSeconds: 700, measured: true, amount: 1450, breakdown: {} },
        });
      });

      expect(mockReplaceWithSettlement).toHaveBeenCalledWith(navigation, { rideId: 'ride-flow', amount: 1450 });
    });

    it('une course annulée rend la carte au repos, boutons flottants compris', async () => {
      jest.useFakeTimers();
      try {
        const { root } = await renderHome();
        await acceptedRide(root);

        await act(async () => {
          realtimeListener?.({
            type: 'ride.cancelled',
            id: 'x1',
            emittedAt: new Date().toISOString(),
            payload: { rideId: 'ride-flow', cancelledBy: 'client' },
          });
        });
        await act(async () => {
          await jest.advanceTimersByTimeAsync(3000);
        });

        expect(shown(root, 'active-ride-screen')).toBe(false);
        expect(shown(root, 'home-bottom-panel')).toBe(true);
        // Plus de course : la bascule en ligne/hors ligne redevient utilisable.
        expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it("L5-07 -- « Ma caisse » navigue vers l'écran de recette, accessible en permanence depuis l'accueil", async () => {
    const { root, navigation } = await renderHome();

    await act(async () => {
      root.root.findByProps({ testID: 'home-go-to-cash' }).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('Cash');
  });

  it("affiche la recette encaissée aujourd'hui telle qu'Odoo l'a calculée (GET /drivers/me/cash)", async () => {
    mockFetchCashSummary.mockResolvedValue({ collectedToday: 8400 });
    const { root } = await renderHome();
    expect(mockFetchCashSummary).toHaveBeenCalled();
    const amount = host(root, 'home-today-amount')[0]!;
    expect(amount.props.children).toBe(formatMoney(8400));
    expect(texts(root)).toContain('Encaissé aujourd’hui');
  });

  it("sans réponse du serveur, l'encaissé du jour reste un tiret -- jamais un zéro inventé", async () => {
    mockFetchCashSummary.mockRejectedValue(new Error('fetch failed'));
    const { root } = await renderHome();
    expect(host(root, 'home-today-amount')[0]!.props.children).toBe('—');
  });

  it("l'encaissé du jour est relu au retour sur l'accueil (après un règlement, une remise)", async () => {
    mockFetchCashSummary.mockResolvedValueOnce({ collectedToday: 8400 }).mockResolvedValueOnce({ collectedToday: 9900 });
    const { root, navigation } = await renderHome();
    const focus = navigation.addListener.mock.calls.find(([event]) => event === 'focus')?.[1] as () => void;
    await act(async () => {
      focus();
    });
    expect(host(root, 'home-today-amount')[0]!.props.children).toBe(formatMoney(9900));
  });

  describe('carte et boutons flottants', () => {
    // Nœuds natifs seulement : `findAllByProps` compterait aussi le composant qui les rend.
    const markers = (root: ReactTestRenderer) =>
      root.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'mock-map-marker');
    const flat = (root: ReactTestRenderer, testID: string) =>
      StyleSheet.flatten(root.root.findByProps({ testID }).props.style);

    it("affiche la carte même sans position (repli sur le centre par défaut, jamais d'écran vide)", async () => {
      const { root } = await renderHome();
      expect(root.root.findAllByProps({ testID: 'mock-map-view' }).length).toBeGreaterThan(0);
      expect(markers(root)).toHaveLength(0);
    });

    it('place un repère « chauffeur » à la position lue', async () => {
      mockGetCurrentPosition.mockResolvedValue({ latitude: 4.049, longitude: 9.695 });
      const { root } = await renderHome();
      expect(markers(root)).toHaveLength(1);
    });

    it('un panneau collé en bas, pleine largeur, coins du haut arrondis', async () => {
      const { root } = await renderHome();
      const style = flat(root, 'home-bottom-panel');
      expect(style.position).toBe('absolute');
      expect(style.bottom).toBe(0);
      expect(style.left).toBe(0);
      expect(style.right).toBe(0);
      expect(style.borderTopLeftRadius).toBeGreaterThan(0);
      expect(style.borderTopRightRadius).toBeGreaterThan(0);
      expect(style.borderBottomLeftRadius ?? 0).toBe(0);
      expect(style.borderBottomRightRadius ?? 0).toBe(0);
    });

    it("le panneau porte « Ma caisse » à gauche et l'encaissé du jour à droite, au-dessus de la bascule", async () => {
      const { root } = await renderHome();
      const panel = host(root, 'home-bottom-panel')[0]!;
      const order = panel
        .findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string')
        .map((node) => node.props.testID as string);
      const index = (id: string) => order.indexOf(id);
      expect(index('home-go-to-cash')).toBeGreaterThanOrEqual(0);
      expect(index('home-today-total')).toBeGreaterThan(index('home-go-to-cash'));
      expect(index('availability-toggle')).toBeGreaterThan(index('home-today-total'));
      const row = flat(root, 'home-panel-row');
      expect(row.flexDirection).toBe('row');
      expect(row.justifyContent).toBe('space-between');
    });

    it('« Ma caisse » est compact : entre 48 et 56 dp de haut', async () => {
      const { root } = await renderHome();
      const style = flat(root, 'home-go-to-cash');
      expect(style.minHeight).toBeGreaterThanOrEqual(48);
      expect(style.minHeight).toBeLessThanOrEqual(56);
    });

    it("l'état de connexion reste affiché, en puce flottante", async () => {
      const { root } = await renderHome();
      expect(root.root.findByProps({ testID: 'connection-state' })).toBeTruthy();
    });
  });
});
