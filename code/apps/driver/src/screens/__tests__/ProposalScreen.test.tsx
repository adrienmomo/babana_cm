import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';

const mockReverseGeocode = jest.fn<Promise<string | null>, [{ latitude: number; longitude: number }]>();
jest.mock('@babana/maps', () => ({
  reverseGeocode: (point: { latitude: number; longitude: number }) => mockReverseGeocode(point),
}));

const mockAlertIncomingProposal = jest.fn();
const mockDismissProposalAlert = jest.fn();
jest.mock('../../proposalAlert', () => ({
  alertIncomingProposal: () => mockAlertIncomingProposal(),
  dismissProposalAlert: () => mockDismissProposalAlert(),
}));

let realtimeListener: ((message: unknown) => void) | null = null;
let mockConnectionStateListener: ((state: string) => void) | null = null;
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
const mockSend = jest.fn();
jest.mock('../../realtime', () => ({
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  onRealtimeConnectionStateChange: (listener: (state: string) => void) => {
    mockConnectionStateListener = listener;
    return () => {
      mockConnectionStateListener = null;
    };
  },
  realtimeClient: {
    send: (...args: unknown[]) => mockSend(...args),
    getState: () => mockConnectionState,
  },
}));

function setConnectionState(state: 'offline' | 'connecting' | 'connected') {
  mockConnectionState = state;
  mockConnectionStateListener?.(state);
}

const mockReplaceWithActiveRide = jest.fn();
jest.mock('../../navigation/transitions', () => ({
  replaceWithActiveRide: (...args: unknown[]) => mockReplaceWithActiveRide(...args),
}));

import { ProposalScreen } from '../ProposalScreen';
import { formatMoney } from '../../format';
import { resetProposalDedup } from '../../proposalDedup';
import type { DriverParamList } from '../../navigation/types';

const RIDE_ID = asRideId('ride-1');
const PARAMS = {
  source: 'realtime' as const,
  rideId: RIDE_ID,
  origin: { latitude: 4.05, longitude: 9.7 },
  destination: { latitude: 4.06, longitude: 9.71 },
  amount: 1200,
  distanceMeters: 3200,
  distanceToOriginMeters: 1400 as number | null,
  // Recalculé dans beforeEach() une fois les faux minuteurs installés -- sinon `expiresAt` est
  // figé à l'heure réelle du chargement du module, alors que `Date.now()` vu par l'écran est
  // gelé par jest à l'heure réelle du beforeEach : sous forte charge (suite complète en
  // parallèle) l'écart dépasse quelques secondes et le compte à rebours attendu (30) tombe à 27.
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  emittedAt: new Date().toISOString(),
};

function fakeNavigation() {
  return { goBack: jest.fn(), reset: jest.fn(), navigate: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Après useFakeTimers() : `Date.now()` est maintenant gelé à une valeur stable, sur laquelle
  // `expiresAt` doit être calé pour que `remainingSeconds()` parte bien de 30.
  PARAMS.expiresAt = new Date(Date.now() + 30_000).toISOString();
  PARAMS.emittedAt = new Date().toISOString();
  realtimeListener = null;
  mockConnectionStateListener = null;
  mockConnectionState = 'connected';
  mockReverseGeocode.mockResolvedValue(null);
  resetProposalDedup();
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
  jest.useRealTimers();
});

async function renderProposal(
  params: DriverParamList['Proposal'] = PARAMS,
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = { key: 'Proposal', name: 'Proposal' as const, params };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<ProposalScreen navigation={navigation} route={route} />);
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

function emitExpired(rideId = RIDE_ID) {
  realtimeListener?.({ type: 'proposal.expired', id: 'e1', emittedAt: new Date().toISOString(), payload: { rideId } });
}

function emitAccepted(rideId = RIDE_ID, clientPhoneNumber: string | null = '+237691234567') {
  realtimeListener?.({
    type: 'proposal.accepted',
    id: 'a1',
    emittedAt: new Date().toISOString(),
    payload: { rideId, clientPhoneNumber },
  });
}

function emitSynced(
  activeRideId: string | null,
  activeRideState: string | null,
  activeProposal: Record<string, unknown> | null = null,
  rideStateKnown = true
) {
  realtimeListener?.({
    type: 'session.synced',
    id: 's1',
    emittedAt: new Date().toISOString(),
    payload: { activeRideId, activeRideState, activeProposal, rideStateKnown, serverTime: new Date().toISOString() },
  });
}

function activeProposalFor(rideId = RIDE_ID, over: Record<string, unknown> = {}) {
  return {
    rideId,
    origin: { latitude: 4.05, longitude: 9.7 },
    destination: { latitude: 4.06, longitude: 9.71 },
    amount: 1200,
    distanceMeters: 3200,
    distanceToOriginMeters: 1400,
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    emittedAt: new Date(Date.now() - 25_000).toISOString(),
    ...over,
  };
}

function emitProposalNew(rideId = RIDE_ID, emittedAt = new Date(Date.now() - 3_000).toISOString()) {
  realtimeListener?.({
    type: 'proposal.new',
    id: 'pn1',
    emittedAt,
    payload: {
      rideId,
      origin: { latitude: 4.05, longitude: 9.7 },
      destination: { latitude: 4.06, longitude: 9.71 },
      amount: 1200,
      distanceMeters: 3200,
      distanceToOriginMeters: 1400,
      expiresAt: new Date(Date.now() + 28_000).toISOString(),
    },
  });
}

const NOTIF_PARAMS = {
  source: 'notification' as const,
  rideId: RIDE_ID,
  expiresAt: null as string | null,
};

describe('ProposalScreen (L6-12)', () => {
  it('critère 1 -- réveille l’appareil au montage, efface l’alerte au démontage', async () => {
    const { root } = await renderProposal();
    expect(mockAlertIncomingProposal).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    renderedRoots.length = 0; // déjà démonté explicitement ci-dessus
    expect(mockDismissProposalAlert).toHaveBeenCalledTimes(1);
  });

  it('affiche départ, arrivée (reverse-géocodés), distance, montant et le compte à rebours', async () => {
    mockReverseGeocode.mockResolvedValueOnce('Akwa, Douala').mockResolvedValueOnce('Bonapriso, Douala');
    const { root } = await renderProposal();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(texts(root)).toContain('Akwa, Douala');
    expect(texts(root)).toContain('Bonapriso, Douala');
    expect(texts(root)).toContain(formatMoney(1200));
    expect(texts(root)).toContain('3.2 km');
    expect(root.root.findByProps({ testID: 'countdown-value' }).props.children).toBe(30);
  });

  it('D51 -- affiche la distance à vide jusqu’au client, et son indisponibilité quand elle est nulle', async () => {
    const { root } = await renderProposal();
    expect(texts(root)).toContain('pour rejoindre le client');
    expect(root.root.findByProps({ testID: 'proposal-approach-distance' }).props.children).toContain('1.4 km');

    const { root: root2 } = await renderProposal({ ...PARAMS, distanceToOriginMeters: null });
    expect(texts(root2)).toContain('Distance jusqu’au client indisponible');
  });

  it('critère 2 -- accepter et refuser respectent une taille minimale de cible tactile', async () => {
    const { root } = await renderProposal();

    const accept = root.root.findByProps({ testID: 'proposal-accept' });
    const reject = root.root.findByProps({ testID: 'proposal-reject' });
    const flatten = (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style);

    expect(flatten(accept.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(56);
    expect(flatten(reject.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(56);
  });

  it('D49 -- accepter n’envoie que proposal.accept ; la bascule vers ActiveRide attend proposal.accepted, jamais un délai', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
    });
    expect(mockSend).toHaveBeenCalledWith('proposal.accept', { rideId: RIDE_ID });
    expect(texts(root)).toContain('Envoi de votre acceptation…');

    // Aucun délai deviné : même après une longue attente, sans accusé de réception, aucune bascule.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();

    await act(async () => {
      emitAccepted();
    });
    // D42 (amoa/questions/REPONSES-2026-09-02.md §1) : le numéro du client, porté par
    // proposal.accepted, voyage jusqu'à ActiveRide.
    expect(mockReplaceWithActiveRide).toHaveBeenCalledWith(
      navigation,
      expect.objectContaining({
        rideId: RIDE_ID,
        origin: PARAMS.origin,
        destination: PARAMS.destination,
        amount: PARAMS.amount,
        clientPhoneNumber: '+237691234567',
      })
    );
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('D49 -- proposal.accepted pour une autre course est ignoré', async () => {
    const { root } = await renderProposal();
    await act(async () => {
      root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
    });
    await act(async () => {
      emitAccepted(asRideId('another-ride'));
    });
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();
  });

  it('D49 -- filet : session.synced confirmant la course bascule vers ActiveRide si proposal.accepted s’est perdu', async () => {
    const { navigation, root } = await renderProposal();
    await act(async () => {
      root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
    });

    // Un session.synced qui ne concerne pas cette course, ou dont l'état n'est pas affecté, ne fait rien.
    await act(async () => {
      emitSynced(asRideId('another-ride'), 'in_progress');
      emitSynced(RIDE_ID, 'requested');
    });
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();

    await act(async () => {
      emitSynced(RIDE_ID, 'assigned');
    });
    // D42 : le filet session.synced ne porte pas le numéro du client -- absent, jamais inventé.
    expect(mockReplaceWithActiveRide).toHaveBeenCalledWith(
      navigation,
      expect.objectContaining({
        rideId: RIDE_ID,
        origin: PARAMS.origin,
        destination: PARAMS.destination,
        amount: PARAMS.amount,
        clientPhoneNumber: null,
      })
    );
  });

  it('critère 3 -- une acceptation tardive (proposal.expired reçu après l’envoi) affiche un message compréhensible, jamais ActiveRide', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
    });

    await act(async () => {
      emitExpired();
    });

    expect(texts(root)).toContain('Cette course a été attribuée -- votre acceptation est arrivée trop tard.');
    expect(root.root.findAllByProps({ testID: 'proposal-accept' })).toHaveLength(0);
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();

    // Un proposal.accepted qui arriverait après coup (course déjà attribuée à un autre) ne rouvre rien.
    await act(async () => {
      emitAccepted();
    });
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();

    // Critère 4 -- retour automatique, sans action requise.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('critère 4 -- une expiration simple (sans acceptation tentée) ramène automatiquement à l’accueil', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      emitExpired();
    });
    expect(texts(root)).toContain('Le délai de réponse est dépassé.');
    expect(navigation.goBack).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('un proposal.expired pour une autre course est ignoré', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      emitExpired(asRideId('another-ride'));
    });

    expect(root.root.findAllByProps({ testID: 'proposal-resolution' })).toHaveLength(0);
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('refuser -- envoie proposal.reject et revient immédiatement à l’accueil', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      root.root.findByProps({ testID: 'proposal-reject' }).props.onPress();
    });

    expect(mockSend).toHaveBeenCalledWith('proposal.reject', { rideId: RIDE_ID });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('le compte à rebours affiché décroît avec le temps', async () => {
    const { root } = await renderProposal();
    expect(root.root.findByProps({ testID: 'countdown-value' }).props.children).toBe(30);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });

    expect(root.root.findByProps({ testID: 'countdown-value' }).props.children).toBeLessThanOrEqual(25);
  });

  // --- L7-04 : mesure du délai d'acheminement, et ouverture depuis une notification ----------

  it('L7-04 critère 4 -- signale proposal.seen à l’affichage réel, une seule fois, avec l’emittedAt d’origine', async () => {
    await renderProposal();

    const seenCalls = mockSend.mock.calls.filter((c) => c[0] === 'proposal.seen');
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0][1]).toEqual({ rideId: RIDE_ID, emittedAt: PARAMS.emittedAt });

    // Un tick de plus ne le renvoie pas.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(mockSend.mock.calls.filter((c) => c[0] === 'proposal.seen')).toHaveLength(1);
  });

  it('mode notification -- revalide (session.resync forcée) et n’affiche ni détails ni boutons avant la réponse', async () => {
    const { root } = await renderProposal(NOTIF_PARAMS);

    expect(mockSend).toHaveBeenCalledWith('session.resync', { lastKnownRideId: RIDE_ID });
    expect(texts(root)).toContain('Vérification de la proposition…');
    expect(root.root.findAllByProps({ testID: 'proposal-accept' })).toHaveLength(0);
    // Pas encore de proposal.seen : rien n'est affiché.
    expect(mockSend.mock.calls.filter((c) => c[0] === 'proposal.seen')).toHaveLength(0);
  });

  it("mode notification -- pendant l'attente, l'écran dit « hors connexion » quand le lien n'est pas établi (un fait, pas un délai)", async () => {
    const { root } = await renderProposal(NOTIF_PARAMS);

    // Connecté : le texte reste neutre.
    expect(texts(root)).toContain('Vérification de la proposition…');
    expect(texts(root)).not.toContain('hors connexion');

    await act(async () => {
      setConnectionState('offline');
    });
    expect(texts(root)).toContain('hors connexion');
    // Toujours aucune conclusion tirée : pas de boutons, pas de message « plus à prendre ».
    expect(root.root.findAllByProps({ testID: 'proposal-accept' })).toHaveLength(0);
    expect(texts(root)).not.toContain('Cette course n’est plus à prendre.');

    // Le lien revient : le fait affiché suit.
    await act(async () => {
      setConnectionState('connected');
    });
    expect(texts(root)).not.toContain('hors connexion');
  });

  it('mode notification -- session.synced avec activeProposal remplit l’écran, avec la véritable échéance, puis signale proposal.seen', async () => {
    const { root } = await renderProposal(NOTIF_PARAMS);
    const active = activeProposalFor(RIDE_ID);

    await act(async () => {
      emitSynced(null, null, active);
    });

    expect(texts(root)).toContain(formatMoney(1200));
    expect(root.root.findByProps({ testID: 'proposal-accept' })).toBeDefined();
    // Véritable échéance : ~5 s restantes, pas 30.
    expect(root.root.findByProps({ testID: 'countdown-value' }).props.children).toBeLessThanOrEqual(6);

    const seenCalls = mockSend.mock.calls.filter((c) => c[0] === 'proposal.seen');
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0][1]).toEqual({ rideId: RIDE_ID, emittedAt: active.emittedAt });
  });

  it('mode notification -- session.synced sans activeProposal dit « plus à prendre », sans boutons, et revient (critère 3)', async () => {
    const { root, navigation } = await renderProposal(NOTIF_PARAMS);

    await act(async () => {
      emitSynced(null, null, null);
    });

    expect(texts(root)).toContain('Cette course n’est plus à prendre.');
    expect(root.root.findAllByProps({ testID: 'proposal-accept' })).toHaveLength(0);
    expect(mockSend.mock.calls.filter((c) => c[0] === 'proposal.seen')).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('mode notification -- un proposal.new qui rattrape la notification remplit l’écran', async () => {
    const { root } = await renderProposal(NOTIF_PARAMS);

    await act(async () => {
      emitProposalNew(RIDE_ID);
    });

    expect(root.root.findByProps({ testID: 'proposal-accept' })).toBeDefined();
    expect(texts(root)).toContain(formatMoney(1200));
  });
});
