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
const mockSend = jest.fn();
jest.mock('../../realtime', () => ({
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  realtimeClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

const mockReplaceWithActiveRide = jest.fn();
jest.mock('../../navigation/transitions', () => ({
  replaceWithActiveRide: (...args: unknown[]) => mockReplaceWithActiveRide(...args),
}));

import { ProposalScreen } from '../ProposalScreen';
import { formatMoney } from '../../format';

const RIDE_ID = asRideId('ride-1');
const PARAMS = {
  rideId: RIDE_ID,
  origin: { latitude: 4.05, longitude: 9.7 },
  destination: { latitude: 4.06, longitude: 9.71 },
  amount: 1200,
  distanceMeters: 3200,
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
};

function fakeNavigation() {
  return { goBack: jest.fn(), reset: jest.fn(), navigate: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  realtimeListener = null;
  mockReverseGeocode.mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
  jest.useRealTimers();
});

async function renderProposal(
  params = PARAMS,
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

  it('critère 2 -- accepter et refuser respectent une taille minimale de cible tactile', async () => {
    const { root } = await renderProposal();

    const accept = root.root.findByProps({ testID: 'proposal-accept' });
    const reject = root.root.findByProps({ testID: 'proposal-reject' });
    const flatten = (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style);

    expect(flatten(accept.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(56);
    expect(flatten(reject.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(56);
  });

  it('accepter -- envoie proposal.accept puis, sans nouvelle réponse, bascule vers ActiveRide après le délai de grâce', async () => {
    const { root, navigation } = await renderProposal();

    await act(async () => {
      root.root.findByProps({ testID: 'proposal-accept' }).props.onPress();
    });
    expect(mockSend).toHaveBeenCalledWith('proposal.accept', { rideId: RIDE_ID });
    expect(texts(root)).toContain('Envoi de votre acceptation…');
    expect(mockReplaceWithActiveRide).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });

    expect(mockReplaceWithActiveRide).toHaveBeenCalledWith(navigation, { rideId: RIDE_ID });
    expect(navigation.goBack).not.toHaveBeenCalled();
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

    // Même après le délai de grâce complet, ActiveRide ne doit jamais être atteint pour une
    // proposition qui n'est plus la sienne.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
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
});
