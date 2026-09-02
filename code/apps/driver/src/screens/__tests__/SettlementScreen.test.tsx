import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';
import { ApiError } from '@babana/api-client';

// `offlineRunner` réel (mêmes garanties qu'en production -- mise en file, rejeu, idempotence,
// déjà couvertes par packages/api-client/test/offline/manager.test.ts), branché sur un faux
// `httpClient` et un stockage en mémoire plutôt que sur `../../auth` et `../../realtime` (que ce
// module importerait sinon transitivement -- `../offline.ts` n'a pas à en dépendre pour ce test).
const mockRequest = jest.fn();
jest.mock('../../offline', () => ({
  offlineRunner: require('@babana/api-client').createOfflineActionRunner({
    httpClient: { request: (...args: unknown[]) => mockRequest(...args) },
    queueStorage: require('@babana/api-client').createInMemoryOfflineQueue(),
  }),
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

// J24 (amoa/questions/L6-14.md) : la réponse de `settle` porte désormais le plafond, la marge et
// le franchissement -- l'écran n'infère plus rien et ne fait plus de second GET /drivers/me/cash.
function settleResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rideId: RIDE_ID,
    state: 'settled',
    amountCollected: 1500,
    driverCashBalance: 9000,
    cashLimit: 15000,
    cashLimitReached: false,
    marginRemaining: 6000,
    ...overrides,
  };
}

describe('SettlementScreen (L6-14)', () => {
  it('critère 1 -- aucun champ de saisie de montant, le montant dû est seulement affiché', async () => {
    const { root } = await renderSettlement();
    expect(root.root.findAllByType(TextInput)).toHaveLength(0);
    expect(texts(root)).toContain(formatMoney(1500));
  });

  it('confirmer -- envoie POST /rides/{id}/settle avec le montant dû (jamais une saisie)', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse());
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith(
      'settleRide',
      expect.objectContaining({ pathParams: { id: RIDE_ID }, body: { amountCollected: 1500 } })
    );
  });

  it('critère 2 -- solde et marge viennent de la réponse de settle, sans second appel (J24)', async () => {
    mockRequest.mockResolvedValueOnce(
      settleResponse({ driverCashBalance: 9000, marginRemaining: 6000 })
    );
    const { root } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-balance' }).props.children).toContain(formatMoney(9000));
    expect(root.root.findByProps({ testID: 'settlement-margin' }).props.children).toContain(formatMoney(6000));
    // Aucun GET /drivers/me/cash : la réponse de settle porte déjà tout.
    expect(mockRequest.mock.calls.filter((c) => c[0] === 'driverCash')).toHaveLength(0);
    expect(mockRequest.mock.calls.filter((c) => c[0] === 'settleRide')).toHaveLength(1);
  });

  it('critère 3 -- cashLimitReached annonce le passage hors ligne, avec un accès à la remise (J24)', async () => {
    mockRequest.mockResolvedValueOnce(
      settleResponse({ driverCashBalance: 15500, cashLimitReached: true, marginRemaining: 0 })
    );
    const { root, navigation } = await renderSettlement();

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-confirm' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'settlement-cap-reached' })).toBeTruthy();
    expect(texts(root)).toContain('hors ligne');
    // Pas de marge affichée quand le plafond est franchi.
    expect(root.root.findAllByProps({ testID: 'settlement-margin' })).toHaveLength(0);

    await act(async () => {
      root.root.findByProps({ testID: 'settlement-go-to-remittance' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Remittance');
  });

  it('sous le plafond -- pas de bannière hors ligne, un bouton « Terminé » ramène à l’accueil', async () => {
    mockRequest.mockResolvedValueOnce(settleResponse({ cashLimitReached: false }));
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
      .mockResolvedValueOnce(settleResponse());
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
    mockRequest.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(settleResponse());
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
});
