import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';

// « Ma priorité » et ses deux détails (19 novembre). Tout ce qui s'affiche vient du serveur : ces
// tests vérifient qu'aucun chiffre n'est inventé ni recalculé, et que le bonus « nouveau » est
// verrouillé une fois la période passée.
let mockUser: { driverPriority?: http.DriverPriority } | null = null;
const mockRefreshUser = jest.fn();
const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  authClient: { getUser: () => mockUser, refreshUser: (...args: unknown[]) => mockRefreshUser(...args) },
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { PriorityScreen } from '../PriorityScreen';
import { RidePointsScreen } from '../RidePointsScreen';
import { StarPointsScreen } from '../StarPointsScreen';
import { PriorityBar } from '../../components/PriorityBar';

const ACTIVE: http.DriverPriority = {
  total: 112, max: 120, ridePoints: 92, ridePointsMax: 100, newDriverPoints: 10, newDriverPointsMax: 10,
  newDriverUntil: '2026-12-17T12:00:00Z', starPoints: 10, starPointsMax: 10,
};
const EXPIRED: http.DriverPriority = { ...ACTIVE, total: 102, newDriverPoints: 0, newDriverUntil: null };

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mockRefreshUser.mockReset();
  mockRequest.mockReset();
  mockUser = null;
});

async function render(element: React.ReactElement) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element);
  });
  roots.push(root);
  return root;
}

const texts = (root: ReactTestRenderer) =>
  root.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .flat()
    .filter((child: unknown) => typeof child === 'string' || typeof child === 'number')
    .join(' ');
const byId = (root: ReactTestRenderer, testID: string) => root.root.findAllByProps({ testID });

function fakeNavigation() {
  return { navigate: jest.fn(), setOptions: jest.fn() };
}

async function renderPriority(priority: http.DriverPriority) {
  mockUser = { driverPriority: priority };
  mockRefreshUser.mockResolvedValue({ user: { driverPriority: priority } });
  const navigation = fakeNavigation();
  const root = await render(
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    <PriorityScreen navigation={navigation} route={{ key: 'Priority', name: 'Priority', params: undefined }} />
  );
  return { root, navigation };
}

describe('PriorityBar', () => {
  it('une piste par sorte de points, aussi large que son maximum, remplie de ce que le serveur a compté', async () => {
    const root = await render(<PriorityBar priority={ACTIVE} />);
    const grow = (id: string) => StyleSheet.flatten(byId(root, id)[0]!.props.style).flexGrow;
    expect([grow('priority-bar-rides'), grow('priority-bar-stars'), grow('priority-bar-new')]).toEqual([100, 10, 10]);
    const fill = StyleSheet.flatten(byId(root, 'priority-bar-rides')[0]!.findAllByType(require('react-native').View)[1]!.props.style);
    expect(fill.width).toBe('92%');
    expect(byId(root, 'priority-bar')[0]!.props.accessibilityValue).toEqual({ min: 0, max: 120, now: 112 });
  });

  it('la piste « nouveau » est verrouillée une fois la période passée', async () => {
    const root = await render(<PriorityBar priority={EXPIRED} />);
    expect(byId(root, 'priority-bar-new')).toHaveLength(0);
    expect(byId(root, 'priority-bar-new-locked').length).toBeGreaterThan(0);
    expect(texts(root)).toContain('🔒');
    expect(texts(root)).toContain('Nouveau · verrouillé');
  });

  it('pendant la période, rien n’est verrouillé', async () => {
    const root = await render(<PriorityBar priority={ACTIVE} />);
    expect(byId(root, 'priority-bar-new-locked')).toHaveLength(0);
  });
});

describe('PriorityScreen', () => {
  it('affiche le total, la barre et le détail des trois sortes de points', async () => {
    const { root } = await renderPriority(ACTIVE);
    const [total, max] = byId(root, 'priority-total')[0]!.props.children;
    expect(total).toBe(112);
    expect(max.props.children.join('')).toBe(' / 120 points');
    expect(byId(root, 'priority-bar').length).toBeGreaterThan(0);
    expect(texts(root)).toContain('92 / 100');
    expect(texts(root)).toContain("Bonus de bienvenue jusqu'au");
  });

  it('relit la priorité à l’ouverture et affiche celle du serveur', async () => {
    mockUser = { driverPriority: ACTIVE };
    mockRefreshUser.mockResolvedValue({ user: { driverPriority: EXPIRED } });
    const root = await render(
      // @ts-expect-error -- fausse navigation minimale
      <PriorityScreen navigation={fakeNavigation()} route={{ key: 'Priority', name: 'Priority', params: undefined }} />
    );
    expect(texts(root)).toContain('102');
  });

  it('« Courses acceptées » et « Note des clients » ouvrent leur détail ; « Nouveau chauffeur » n’ouvre rien', async () => {
    const { root, navigation } = await renderPriority(ACTIVE);
    await act(async () => {
      byId(root, 'priority-detail-rides')[0]!.props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('RidePoints');
    await act(async () => {
      byId(root, 'priority-detail-stars')[0]!.props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('StarPoints');
    expect(byId(root, 'priority-detail-new')[0]!.props.onPress).toBeUndefined();
  });

  it('période passée : la carte « Nouveau chauffeur » dit que les points sont verrouillés', async () => {
    const { root } = await renderPriority(EXPIRED);
    expect(texts(root)).toContain('Période de bienvenue terminée : ces points sont verrouillés.');
    expect(texts(root)).toContain('0 / 10');
  });

  it('sans priorité connue, un message plutôt qu’un zéro inventé', async () => {
    mockUser = null;
    mockRefreshUser.mockRejectedValue(new TypeError('Network request failed'));
    const root = await render(
      // @ts-expect-error -- fausse navigation minimale
      <PriorityScreen navigation={fakeNavigation()} route={{ key: 'Priority', name: 'Priority', params: undefined }} />
    );
    expect(byId(root, 'priority-unavailable').length).toBeGreaterThan(0);
  });
});

const LOG_PAGE: http.RidePointsLogResponse = {
  ridePoints: 99,
  ridePointsMax: 100,
  entries: [
    { id: '2', kind: 'missed', delta: -1, balanceAfter: 99, occurredAt: '2026-11-19T09:12:00Z', rideReference: 'C2026002711', pickupLabel: 'Akwa', dropoffLabel: 'Bonapriso' },
    { id: '1', kind: 'completed', delta: 1, balanceAfter: 100, occurredAt: '2026-11-18T17:40:00Z', rideReference: 'C2026002698', pickupLabel: null, dropoffLabel: null },
  ],
  nextCursor: 'next',
};

describe('RidePointsScreen', () => {
  it('le journal : −1 en rouge pour une proposition sans réponse, +1 en vert pour une course terminée', async () => {
    mockRequest.mockResolvedValue(LOG_PAGE);
    const root = await render(<RidePointsScreen />);
    expect(mockRequest).toHaveBeenCalledWith('driverRidePointsLog', { query: {} });
    const delta = (id: string) => byId(root, `ride-points-delta-${id}`).find((node) => typeof node.type === 'string')!;
    expect(delta('2').props.children).toBe('-1');
    expect(delta('1').props.children).toBe('+1');
    expect(StyleSheet.flatten(delta('2').props.style).color).not.toBe(StyleSheet.flatten(delta('1').props.style).color);
    expect(texts(root)).toContain('Proposition sans réponse');
    expect(texts(root)).toContain('Course terminée');
    expect(texts(root)).toContain('Akwa → Bonapriso');
  });

  it('charge la page suivante avec le curseur du serveur', async () => {
    mockRequest.mockResolvedValueOnce(LOG_PAGE).mockResolvedValueOnce({ ...LOG_PAGE, entries: [], nextCursor: null });
    const root = await render(<RidePointsScreen />);
    await act(async () => {
      byId(root, 'ride-points-list')[0]!.props.onEndReached();
    });
    expect(mockRequest).toHaveBeenLastCalledWith('driverRidePointsLog', { query: { cursor: 'next' } });
  });

  it('une erreur propose de réessayer', async () => {
    mockRequest.mockRejectedValueOnce(new Error('hors connexion')).mockResolvedValueOnce(LOG_PAGE);
    const root = await render(<RidePointsScreen />);
    expect(byId(root, 'ride-points-error').length).toBeGreaterThan(0);
    await act(async () => {
      byId(root, 'ride-points-retry')[0]!.props.onPress();
    });
    expect(byId(root, 'ride-points-list').length).toBeGreaterThan(0);
  });
});

const STARS: http.StarPointsResponse = {
  starPoints: 5,
  starPointsMax: 10,
  smoothedAverage: 4.45,
  ratingCount: 8,
  ratingAverage: 1,
  priorCount: 50,
  priorValue: 5,
  tiers: [
    { above: 4.5, points: 10, applied: false },
    { above: 4, points: 5, applied: true },
  ],
};

describe('StarPointsScreen', () => {
  it('le calcul des points de note, sans liste des avis, et le seul palier qui compte', async () => {
    mockRequest.mockResolvedValue(STARS);
    const root = await render(<StarPointsScreen />);
    expect(mockRequest).toHaveBeenCalledWith('driverStarPoints');
    expect(texts(root)).toContain('★ 4,45');
    expect(texts(root)).toContain('★ 1,0');
    expect(texts(root)).toContain('50 × ★ 5');
    expect(texts(root).match(/Votre palier/g)).toHaveLength(1);
    expect(byId(root, 'star-points-tier-4')[0]!.findAllByType(Text).map((node) => node.props.children)).toContain('Votre palier');
  });

  it('sans avis, la moyenne réelle est un tiret', async () => {
    mockRequest.mockResolvedValue({ ...STARS, ratingCount: 0, ratingAverage: null });
    const root = await render(<StarPointsScreen />);
    expect(byId(root, 'star-points-raw-average').find((node) => typeof node.type === 'string')!.props.children).toBe('—');
  });
});
