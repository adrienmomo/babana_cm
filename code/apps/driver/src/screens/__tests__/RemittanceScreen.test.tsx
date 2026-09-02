import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';

// `offlineRunner` réel, branché sur un faux `httpClient` (même patron que
// SettlementScreen.test.tsx -- voir ce fichier pour le raisonnement) : `../../api/cash.ts`
// (`declareRemittance`) reste réel lui aussi, c'est justement lui qui porte la mise en file
// depuis ce soir (L6-16).
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

import { RemittanceScreen } from '../RemittanceScreen';
import { formatMoney } from '../../format';

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

async function renderRemittance(navigation = fakeNavigation()) {
  const route = { key: 'Remittance', name: 'Remittance' as const, params: undefined };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<RemittanceScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

function setAmount(root: ReactTestRenderer, value: string) {
  root.root.findByProps({ testID: 'remittance-amount-input' }).props.onChangeText(value);
}

describe('RemittanceScreen (L5-04, L5-07)', () => {
  it('le bouton de déclaration est désactivé tant qu’aucun montant valide n’est saisi', async () => {
    const { root } = await renderRemittance();

    expect(root.root.findByProps({ testID: 'remittance-submit' }).props.disabled).toBe(true);

    await act(async () => {
      setAmount(root, '0');
    });
    expect(root.root.findByProps({ testID: 'remittance-submit' }).props.disabled).toBe(true);

    await act(async () => {
      setAmount(root, '8400');
    });
    expect(root.root.findByProps({ testID: 'remittance-submit' }).props.disabled).toBe(false);
  });

  it('déclare le montant saisi avec une clé d’idempotence', async () => {
    mockRequest.mockResolvedValueOnce({
      id: 'r1',
      amount: 8400,
      status: 'pending',
      driverCashBalance: 0,
    });
    const { root } = await renderRemittance();

    await act(async () => {
      setAmount(root, '8400');
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-submit' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith(
      'createRemittance',
      expect.objectContaining({ body: { amount: 8400 }, idempotencyKey: expect.any(String) })
    );
    expect(root.root.findByProps({ testID: 'remittance-declared' })).toBeTruthy();
    expect(texts(root)).toContain(formatMoney(8400));
  });

  it('un retour à l’accueil après déclaration remplace la pile (pas de retour en arrière vers le formulaire)', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 });
    const { root, navigation } = await renderRemittance();

    await act(async () => {
      setAmount(root, '8400');
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-submit' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-done' }).props.onPress();
    });

    expect(mockReplaceWithHome).toHaveBeenCalledWith(navigation);
  });

  it('critère 5 -- hors connexion, la déclaration est mise en attente puis renvoyée avec succès', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 });
    const { root } = await renderRemittance();

    await act(async () => {
      setAmount(root, '8400');
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-submit' }).props.onPress();
    });
    expect(root.root.findByProps({ testID: 'remittance-queued' })).toBeTruthy();

    await act(async () => {
      root.root.findByProps({ testID: 'remittance-retry' }).props.onPress();
    });
    expect(root.root.findByProps({ testID: 'remittance-declared' })).toBeTruthy();
  });

  it('critère 5 -- un renvoi réutilise la même clé d’idempotence : pas de double déclaration', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 });
    const { root } = await renderRemittance();

    await act(async () => {
      setAmount(root, '8400');
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-submit' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-retry' }).props.onPress();
    });

    const remittanceCalls = mockRequest.mock.calls.filter((c) => c[0] === 'createRemittance');
    expect(remittanceCalls).toHaveLength(2);
    expect(remittanceCalls[0][1].idempotencyKey).toBe(remittanceCalls[1][1].idempotencyKey);
  });

  it('une erreur métier affiche un message, sans mise en attente', async () => {
    mockRequest.mockRejectedValueOnce(new ApiError('VALIDATION_ERROR', 'montant invalide', 400));
    const { root } = await renderRemittance();

    await act(async () => {
      setAmount(root, '8400');
    });
    await act(async () => {
      root.root.findByProps({ testID: 'remittance-submit' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'remittance-error' })).toBeTruthy();
    expect(root.root.findAllByProps({ testID: 'remittance-queued' })).toHaveLength(0);
  });

  it('aucun libellé ne contient revenus, gains, salaire ou bénéfice', async () => {
    const { root } = await renderRemittance();
    const rendered = texts(root).toLowerCase();
    for (const forbidden of ['revenus', 'gains', 'salaire', 'bénéfice', 'benefice']) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});
