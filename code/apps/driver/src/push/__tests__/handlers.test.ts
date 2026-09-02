import {
  routeProposalNotification,
  handleProposalPushMessage,
  consumePendingProposalNavigation,
  type ProposalRouteDeps,
} from '../handlers';
import { resetProposalDedup } from '../../proposalDedup';

/**
 * L7-04 : routage et déduplication d'un message push de proposition -- la logique qui s'écrit et
 * se teste sans SDK. Le fait qu'un message Firebase arrive réellement rejoint la passe avec
 * appareil (L6-19).
 */

function makeDeps(over: Partial<ProposalRouteDeps> = {}) {
  const shown: Array<{ rideId: string; expiresAt: string | null }> = [];
  const handled = new Set<string>();
  const deps: ProposalRouteDeps = {
    isHandled: (rideId) => handled.has(rideId),
    markHandled: (rideId) => handled.add(rideId),
    showProposal: (rideId, expiresAt) => shown.push({ rideId, expiresAt }),
    ...over,
  };
  return { deps, shown, handled };
}

beforeEach(() => {
  resetProposalDedup();
  // Vide toute navigation en attente laissée par un test précédent.
  consumePendingProposalNavigation();
});

describe('routeProposalNotification (L7-04)', () => {
  it('ouvre l’écran de proposition pour une première notification, avec l’échéance portée', () => {
    const { deps, shown } = makeDeps();
    const result = routeProposalNotification(
      { type: 'proposal', rideId: 'ride-1', expiresAt: '2026-09-05T10:00:30.000Z' },
      deps
    );
    expect(result).toBe('shown');
    expect(shown).toEqual([{ rideId: 'ride-1', expiresAt: '2026-09-05T10:00:30.000Z' }]);
  });

  it('sans échéance dans la charge utile, ouvre quand même l’écran avec expiresAt null', () => {
    const { deps, shown } = makeDeps();
    routeProposalNotification({ type: 'proposal', rideId: 'ride-1' }, deps);
    expect(shown).toEqual([{ rideId: 'ride-1', expiresAt: null }]);
  });

  it('critère 2 -- une proposition déjà prise en charge est un doublon, jamais un second écran', () => {
    const { deps, shown } = makeDeps({ isHandled: () => true });
    const result = routeProposalNotification({ type: 'proposal', rideId: 'ride-1' }, deps);
    expect(result).toBe('duplicate');
    expect(shown).toHaveLength(0);
  });

  it('marque la proposition avant d’ouvrir -- une seconde notification identique est alors un doublon', () => {
    const { deps, shown } = makeDeps();
    routeProposalNotification({ type: 'proposal', rideId: 'ride-1' }, deps);
    const second = routeProposalNotification({ type: 'proposal', rideId: 'ride-1' }, deps);
    expect(second).toBe('duplicate');
    expect(shown).toHaveLength(1);
  });

  it('ignore un message qui n’est pas une proposition, ou sans rideId', () => {
    const { deps, shown } = makeDeps();
    expect(routeProposalNotification({ type: 'ride.cancelled', rideId: 'r' }, deps)).toBe('ignored');
    expect(routeProposalNotification({ type: 'proposal' }, deps)).toBe('ignored');
    expect(routeProposalNotification({ type: 'proposal', rideId: '' }, deps)).toBe('ignored');
    expect(routeProposalNotification({}, deps)).toBe('ignored');
    expect(shown).toHaveLength(0);
  });
});

describe('handleProposalPushMessage -- déduplication partagée et navigation différée', () => {
  it('navigation pas encore prête : la proposition est mise en attente pour HomeScreen, une seule fois', () => {
    const result = handleProposalPushMessage({ type: 'proposal', rideId: 'ride-cold', expiresAt: null });
    expect(result).toBe('shown');

    const pending = consumePendingProposalNavigation();
    expect(pending).toEqual({ rideId: 'ride-cold', expiresAt: null });
    // Consommée : plus rien en attente.
    expect(consumePendingProposalNavigation()).toBeNull();
  });

  it('partage le registre de déduplication avec HomeScreen -- une notification pour une course déjà vue par le WebSocket est un doublon', () => {
    // Simule ce que fait HomeScreen sur proposal.new.
    const { markProposalHandled } = jest.requireActual('../../proposalDedup');
    markProposalHandled('ride-ws');

    const result = handleProposalPushMessage({ type: 'proposal', rideId: 'ride-ws', expiresAt: null });
    expect(result).toBe('duplicate');
    expect(consumePendingProposalNavigation()).toBeNull();
  });
});
