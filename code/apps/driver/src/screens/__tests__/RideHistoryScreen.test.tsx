import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';
import { http } from '@babana/contracts';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// Même runner réel que SettlementScreen.test.tsx : la note corrigée passe par la file hors
// connexion, comme celle posée à l'encaissement.
const mockOfflineRequest = jest.fn();
jest.mock('../../offline', () => ({
  offlineRunner: require('@babana/api-client').createOfflineActionRunner({
    httpClient: { request: (...args: unknown[]) => mockOfflineRequest(...args) },
    queueStorage: require('@babana/api-client').createInMemoryOfflineQueue(),
  }),
}));

import { RideHistoryScreen } from '../RideHistoryScreen';
import { formatMoney } from '../../format';

const ENTRY = http.driverRideHistoryResponseExample.rides[0]!;
const RATED = { ...ENTRY, id: '11111111-1111-4111-8111-111111111111', clientRating: 2 };
const UNRATED = { ...ENTRY, id: '22222222-2222-4222-8222-222222222222', clientRating: null, status: 'completed' as const };
const CANCELLED = {
  ...ENTRY,
  id: '33333333-3333-4333-8333-333333333333',
  clientRating: null,
  clientRatingAllowed: false,
  status: 'cancelled' as const,
};

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mockRequest.mockReset();
  mockOfflineRequest.mockReset();
});

async function renderHistory() {
  const navigation = { navigate: jest.fn() };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<RideHistoryScreen navigation={navigation} route={{ key: 'RideHistory', name: 'RideHistory', params: undefined }} />);
  });
  roots.push(root);
  return root;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

function starColor(root: ReactTestRenderer, rideId: string, value: number): string {
  const star = root.root.findByProps({ testID: `history-${rideId}-star-${value}-glyph` });
  const style = Array.isArray(star.props.style) ? Object.assign({}, ...star.props.style.filter(Boolean)) : star.props.style;
  return style.color;
}

describe('RideHistoryScreen -- « Mes courses » du chauffeur', () => {
  it('liste ses courses : date, trajet, montant, statut, et la note donnée au client', async () => {
    mockRequest.mockResolvedValue({ rides: [RATED, UNRATED, CANCELLED], nextCursor: null });
    const root = await renderHistory();

    expect(mockRequest).toHaveBeenCalledWith('driverRideHistory', { query: {} });
    expect(texts(root)).toContain('vers Carrefour Tiff');
    expect(texts(root)).toContain(formatMoney(700));
    expect(texts(root)).toContain('Encaissée');
    expect(texts(root)).toContain('Annulée');
    expect(starColor(root, RATED.id, 2)).not.toBe(starColor(root, RATED.id, 3));
  });

  it('une course annulée ne se note pas : pas d’étoiles', async () => {
    mockRequest.mockResolvedValue({ rides: [CANCELLED], nextCursor: null });
    const root = await renderHistory();

    expect(root.root.findAllByProps({ testID: `history-${CANCELLED.id}-star-1` })).toHaveLength(0);
  });

  it('une course non notée invite à noter', async () => {
    mockRequest.mockResolvedValue({ rides: [UNRATED], nextCursor: null });
    const root = await renderHistory();

    expect(texts(root)).toContain('Notez votre client');
  });

  it('corriger la note : un appui envoie la nouvelle note et l’affiche aussitôt', async () => {
    mockRequest.mockResolvedValue({ rides: [RATED], nextCursor: null });
    mockOfflineRequest.mockResolvedValue({ rideId: RATED.id, rating: 5 });
    const root = await renderHistory();

    await act(async () => {
      root.root.findByProps({ testID: `history-${RATED.id}-star-5` }).props.onPress();
    });

    expect(mockOfflineRequest).toHaveBeenCalledWith(
      'rateClient',
      expect.objectContaining({ pathParams: { id: RATED.id }, body: { rating: 5 } })
    );
    expect(starColor(root, RATED.id, 5)).toBe(starColor(root, RATED.id, 1));
  });

  it('un refus du serveur rétablit la note d’avant et dit pourquoi', async () => {
    mockRequest.mockResolvedValue({ rides: [RATED], nextCursor: null });
    mockOfflineRequest.mockRejectedValue(new ApiError('RATING_NOT_ALLOWED', 'non', 403));
    const root = await renderHistory();
    const filledColor = starColor(root, RATED.id, 1);

    await act(async () => {
      root.root.findByProps({ testID: `history-${RATED.id}-star-5` }).props.onPress();
    });

    expect(starColor(root, RATED.id, 5)).not.toBe(filledColor);
    expect(starColor(root, RATED.id, 2)).toBe(filledColor);
    expect(root.root.findAllByProps({ testID: `history-${RATED.id}-error` }).length).toBeGreaterThan(0);
  });

  it('charge la page suivante au défilement, avec le curseur du serveur', async () => {
    mockRequest
      .mockResolvedValueOnce({ rides: [RATED], nextCursor: RATED.id })
      .mockResolvedValueOnce({ rides: [UNRATED], nextCursor: null });
    const root = await renderHistory();

    await act(async () => {
      root.root.findByProps({ testID: 'driver-history-list' }).props.onEndReached();
    });

    expect(mockRequest).toHaveBeenLastCalledWith('driverRideHistory', { query: { cursor: RATED.id } });
    expect(root.root.findAllByProps({ testID: `history-row-${UNRATED.id}` }).length).toBeGreaterThan(0);
  });

  it('hors connexion, le dit et propose de réessayer', async () => {
    mockRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    const root = await renderHistory();

    expect(root.root.findAllByProps({ testID: 'driver-history-error' }).length).toBeGreaterThan(0);
    mockRequest.mockResolvedValueOnce({ rides: [RATED], nextCursor: null });
    await act(async () => {
      root.root.findByProps({ testID: 'driver-history-retry' }).props.onPress();
    });
    expect(root.root.findAllByProps({ testID: `history-row-${RATED.id}` }).length).toBeGreaterThan(0);
  });

  it('aucune course : le dit', async () => {
    mockRequest.mockResolvedValue({ rides: [], nextCursor: null });
    const root = await renderHistory();
    expect(texts(root)).toContain('Aucune course pour le moment');
  });
});
