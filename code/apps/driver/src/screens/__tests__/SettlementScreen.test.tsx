import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const mockReplaceWithHome = jest.fn();
jest.mock('../../navigation/transitions', () => ({
  replaceWithHome: (...args: unknown[]) => mockReplaceWithHome(...args),
}));

import { SettlementScreen } from '../SettlementScreen';
import { formatMoney } from '../../format';

const RIDE_ID = asRideId('ride-1');
const PARAMS = { rideId: RIDE_ID, amount: 1500 };

function fakeNavigation() {
  return { navigate: jest.fn(), reset: jest.fn(), goBack: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderSettlement(params = PARAMS, navigation = fakeNavigation()) {
  const route = { key: 'Settlement', name: 'Settlement' as const, params };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale
    root = create(<SettlementScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

function settleResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return { rideId: RIDE_ID, state: 'settled', amountCollected: 1500, driverCashBalance: 9000, ...overrides };
}

function cashResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return { balance: 9000, limit: 15000, collectedToday: 9000, ...overrides };
}

describe('SettlementScreen (L6-14)', () => {
  it('critère 1 -- aucun champ de saisie de montant, le montant dû est seulement affiché', async () => {
    const { root } = await renderSettlement();
    expect(root.root.findAllByType(TextInput)).toHaveLength(0);
    expect(texts(root)).toContain(formatMoney(1500));
  });

  it('confirmer -- envoie POST /rides/{id}/settle avec le montant dû (jamais une saisie)', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse()).mockResolvedValueOnce(cashResponse());
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith(
      'settleRide',
      expect.objectContaining({ pathParams: { id: RIDE_ID }, body: { amountCollected: 1500 } })
    );
  });

  it('critère 2 -- après confirmation, le nouveau solde et la marge avant plafond s’affichent (lus du serveur)', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse({ driverCashBalance: 9000 })).mockResolvedValueOnce(cashResponse({ balance: 9000, limit: 15000 }));
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-balance' }).props.children).toContain(formatMoney(9000));
    expect(root.root.findByProps({ testID: 'settlement-margin' }).props.children).toContain(formatMoney(6000));
    expect(mockRequest).toHaveBeenCalledWith('driverCash');
  });

  it('critère 3 -- un encaissement qui franchit le plafond est annoncé, avec un accès à la remise', async () => {
    mockRequest
      .mockResolvedValueOnce(settleResponse({ driverCashBalance: 15500 }))
      .mockResolvedValueOnce(cashResponse({ balance: 15500, limit: 15000 }));
    const { root, navigation } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-cap-reached' })).toBeTruthy();
    expect(texts(root)).toContain('hors ligne');

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-go-to-remittance' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Remittance');
  });

  it('sous le plafond -- pas de bannière hors ligne, un bouton « Terminé » ramène à l’accueil', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse({ driverCashBalance: 9000 })).mockResolvedValueOnce(cashResponse({ balance: 9000, limit: 15000 }));
    const { root, navigation } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });
    expect(root.root.findAllByProps({ testID: 'settlement-cap-reached' })).toHaveLength(0);

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-done' }).props.onPress();
    });
    expect(mockReplaceWithHome).toHaveBeenCalledWith(navigation);
  });

  it('critère 4 -- hors connexion, la confirmation est mise en attente puis renvoyée avec succès', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(settleResponse())
      .mockResolvedValueOnce(cashResponse());
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });
    expect(root.root.findByProps({ testID: 'settlement-queued' })).toBeTruthy();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-retry' }).props.onPress();
    });
    expect(root.root.findByProps({ testID: 'settlement-result' })).toBeTruthy();
  });

  it('critère 5 -- un renvoi réutilise la même clé d’idempotence : pas de double encaissement', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(settleResponse()).mockResolvedValueOnce(cashResponse());
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'settlement-retry' }).props.onPress();
    });

    const settleCalls = mockRequest.mock.calls.filter((c) => c[0] === 'settleRide');
    expect(settleCalls).toHaveLength(2);
    expect(settleCalls[0][1].idempotencyKey).toBe(settleCalls[1][1].idempotencyKey);
  });

  it('une erreur métier (montant qui ne correspond pas) affiche un message, sans mise en attente', async () => {
    mockRequest.mockRejectedValueOnce(new ApiError('SETTLEMENT_AMOUNT_MISMATCH', 'montant incorrect', 409));
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-error' })).toBeTruthy();
    expect(root.root.findAllByProps({ testID: 'settlement-queued' })).toHaveLength(0);
  });

  it('si GET /drivers/me/cash échoue, le nouveau solde reste affiché, sans la marge', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse({ driverCashBalance: 9000 })).mockRejectedValueOnce(new Error('offline'));
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-balance' }).props.children).toContain(formatMoney(9000));
    expect(root.root.findAllByProps({ testID: 'settlement-margin' })).toHaveLength(0);
  });
});
