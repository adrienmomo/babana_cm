import React from 'react';
import { FlatList, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { http } from '@babana/contracts';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { HistoryScreen } from '../HistoryScreen';

const ENTRY = http.rideHistoryResponseExample.rides[0]!;

function entry(overrides: Partial<http.RideHistoryEntry>): http.RideHistoryEntry {
  return { ...ENTRY, ...overrides };
}

function fakeNavigation() {
  return { navigate: jest.fn() };
}

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mockRequest.mockReset();
});

async function renderHistory(navigation = fakeNavigation()) {
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<HistoryScreen navigation={navigation} route={{ key: 'History', name: 'History', params: undefined }} />);
  });
  roots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

describe('HistoryScreen (L6-10)', () => {
  it('liste les courses avec date, trajet, montant et statut', async () => {
    mockRequest.mockResolvedValue({
      rides: [entry({}), entry({ id: '22222222-2222-4333-8444-555555555555', status: 'cancelled', invoiceAvailable: false })],
      nextCursor: null,
    });

    const { root } = await renderHistory();

    expect(mockRequest).toHaveBeenCalledWith('rideHistory', { query: {} });
    expect(texts(root)).toContain('vers Carrefour Tiff');
    expect(texts(root)).toContain('vers Rond-point Deïdo');
    expect(texts(root)).toContain('Payée');
    expect(texts(root)).toContain('Annulée');
    expect(texts(root)).toContain(`${(700).toLocaleString('fr-FR')} FCFA`);
  });

  it('une course payée ouvre sa facture, une course annulée ne mène nulle part', async () => {
    const cancelledId = '22222222-2222-4333-8444-555555555555';
    mockRequest.mockResolvedValue({
      rides: [entry({}), entry({ id: cancelledId, status: 'cancelled', invoiceAvailable: false })],
      nextCursor: null,
    });
    const { root, navigation } = await renderHistory();

    await act(async () => {
      root.root.findByProps({ testID: `history-row-${ENTRY.id}` }).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('Invoice', { rideId: ENTRY.id });
    expect(root.root.findByProps({ testID: `history-row-${cancelledId}` }).props.disabled).toBe(true);
  });

  it('charge la page suivante au défilement, avec le curseur du serveur, une seule fois', async () => {
    const second = entry({ id: '33333333-2222-4333-8444-555555555555' });
    mockRequest
      .mockResolvedValueOnce({ rides: [entry({})], nextCursor: ENTRY.id })
      .mockResolvedValueOnce({ rides: [second], nextCursor: null });
    const { root } = await renderHistory();

    await act(async () => {
      root.root.findByType(FlatList).props.onEndReached();
    });
    await act(async () => {
      root.root.findByType(FlatList).props.onEndReached();
    });

    expect(mockRequest).toHaveBeenNthCalledWith(2, 'rideHistory', { query: { cursor: ENTRY.id } });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(root.root.findByType(FlatList).props.data).toHaveLength(2);
  });

  it('aucune course : un message, pas une page blanche', async () => {
    mockRequest.mockResolvedValue({ rides: [], nextCursor: null });
    const { root } = await renderHistory();
    expect(root.root.findByProps({ testID: 'history-empty' })).toBeTruthy();
  });

  it('un échec de chargement propose de réessayer', async () => {
    mockRequest.mockRejectedValueOnce(new Error('réseau')).mockResolvedValueOnce({ rides: [entry({})], nextCursor: null });
    const { root } = await renderHistory();

    await act(async () => {
      root.root.findByProps({ testID: 'history-retry' }).props.onPress();
    });

    expect(texts(root)).toContain('vers Carrefour Tiff');
  });
});
