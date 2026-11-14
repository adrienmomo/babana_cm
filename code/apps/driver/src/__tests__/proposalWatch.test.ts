import type { realtime } from '@babana/contracts';
import { attachProposalHost, handleDetachedProposalMessage, isProposalHostAttached, type ProposalWatchDeps } from '../proposalWatch';

// Décision du 14 novembre : un chauffeur en ligne reçoit ses courses même app fermée. Balayer
// l'app démonte l'accueil (seul écouteur de `proposal.new`) : ce module sonne l'alerte à sa place.

function proposalNew(rideId = 'ride-1'): realtime.ProposalNewMessage {
  return {
    type: 'proposal.new',
    id: 'm',
    emittedAt: '2026-11-14T10:00:00Z',
    payload: { rideId, expiresAt: '2026-11-14T10:00:30Z' },
  } as realtime.ProposalNewMessage;
}

function deps(over: Partial<ProposalWatchDeps> = {}) {
  const routed: Array<[string, string]> = [];
  const d: ProposalWatchDeps & { alerts: number } = {
    alerts: 0,
    isHostAttached: () => false,
    route: (rideId, expiresAt) => {
      routed.push([rideId, expiresAt]);
      return 'shown';
    },
    alert: () => {
      d.alerts += 1;
    },
    ...over,
  };
  return { d, routed };
}

test('aucun écran monté : la proposition est gardée pour la réouverture et l’alerte sonne', () => {
  const { d, routed } = deps();
  handleDetachedProposalMessage(proposalNew(), d);
  expect(routed).toEqual([['ride-1', '2026-11-14T10:00:30Z']]);
  expect(d.alerts).toBe(1);
});

test('accueil monté : il s’en charge seul, ce module ne fait rien', () => {
  const { d, routed } = deps({ isHostAttached: () => true });
  handleDetachedProposalMessage(proposalNew(), d);
  expect(routed).toEqual([]);
  expect(d.alerts).toBe(0);
});

test('proposition déjà prise en charge : pas de seconde alerte', () => {
  const { d } = deps({ route: () => 'duplicate' });
  handleDetachedProposalMessage(proposalNew(), d);
  expect(d.alerts).toBe(0);
});

test('une proposition retrouvée par resynchronisation (reconnexion app fermée) sonne aussi', () => {
  const { d, routed } = deps();
  handleDetachedProposalMessage(
    {
      type: 'session.synced',
      id: 'm',
      emittedAt: '2026-11-14T10:00:00Z',
      payload: { activeProposal: { rideId: 'ride-2', expiresAt: '2026-11-14T10:00:20Z' } },
    } as realtime.SessionSyncedMessage,
    d
  );
  expect(routed).toEqual([['ride-2', '2026-11-14T10:00:20Z']]);
  expect(d.alerts).toBe(1);
});

test('les autres messages sont ignorés', () => {
  const { d, routed } = deps();
  handleDetachedProposalMessage({ type: 'ride.started', id: 'm', emittedAt: '', payload: { rideId: 'r' } } as realtime.ServerToClientMessage, d);
  expect(routed).toEqual([]);
});

test('attachProposalHost : attaché tant qu’un accueil est monté, détacher deux fois ne décompte qu’une fois', () => {
  expect(isProposalHostAttached()).toBe(false);
  const detachA = attachProposalHost();
  const detachB = attachProposalHost();
  detachA();
  detachA();
  expect(isProposalHostAttached()).toBe(true);
  detachB();
  expect(isProposalHostAttached()).toBe(false);
});
