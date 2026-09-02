import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';

const mockFetchCashSummary = jest.fn();
jest.mock('../../api/cash', () => ({
  fetchCashSummary: (...args: unknown[]) => mockFetchCashSummary(...args),
}));

import { CashScreen } from '../CashScreen';
import { formatMoney } from '../../format';

function fakeNavigation() {
  return {
    navigate: jest.fn(),
    addListener: jest.fn((_event: string, _handler: () => void) => jest.fn()),
  };
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

async function renderCash(navigation = fakeNavigation()) {
  const route = { key: 'Cash', name: 'Cash' as const, params: undefined };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<CashScreen navigation={navigation} route={route} />);
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

function cashResponse(overrides: Partial<http.DriverCashResponse> = {}): http.DriverCashResponse {
  return {
    balance: 8400,
    limit: 15000,
    marginRemaining: 6600,
    collectedToday: 8400,
    remittances: [],
    ...overrides,
  };
}

describe('CashScreen (L5-07)', () => {
  // --- Critère 1 : aucun libellé « revenus », « gains », « salaire », « bénéfice » (É6) -------

  it("critère 1 -- aucun libellé ne contient revenus, gains, salaire ou bénéfice", async () => {
    mockFetchCashSummary.mockResolvedValueOnce(
      cashResponse({
        remittances: [
          {
            id: 'r1',
            declaredAt: '2026-08-30T07:15:00Z',
            amount: 12000,
            countedAmount: 12000,
            status: 'validated',
            supervisorName: 'Awa Ngo',
          },
        ],
      })
    );
    const { root } = await renderCash();

    const rendered = texts(root).toLowerCase();
    for (const forbidden of ['revenus', 'gains', 'salaire', 'bénéfice', 'benefice']) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(rendered).toContain('recette');
  });

  // --- Critère 2 : la marge restante avant plafond est visible ------------------------------

  it('critère 2 -- affiche encaissé du jour, solde et marge, tels que renvoyés par le serveur', async () => {
    mockFetchCashSummary.mockResolvedValueOnce(
      cashResponse({ balance: 9000, marginRemaining: 6000, collectedToday: 4200 })
    );
    const { root } = await renderCash();

    expect(root.root.findByProps({ testID: 'cash-collected-today' }).props.children).toBe(formatMoney(4200));
    expect(root.root.findByProps({ testID: 'cash-balance' }).props.children).toBe(formatMoney(9000));
    expect(root.root.findByProps({ testID: 'cash-margin-remaining' }).props.children).toBe(formatMoney(6000));
  });

  it('un plafond proche affiche un avertissement de proximité', async () => {
    // marginRemaining/limit = 1000/15000 ≈ 6.7 % : sous le seuil de 20 % (danger).
    mockFetchCashSummary.mockResolvedValueOnce(cashResponse({ marginRemaining: 1000, limit: 15000 }));
    const { root } = await renderCash();

    expect(root.root.findByProps({ testID: 'cash-margin-warning' })).toBeTruthy();
  });

  it('une marge confortable n’affiche aucun avertissement', async () => {
    mockFetchCashSummary.mockResolvedValueOnce(cashResponse({ marginRemaining: 12000, limit: 15000 }));
    const { root } = await renderCash();

    expect(root.root.findAllByProps({ testID: 'cash-margin-warning' })).toHaveLength(0);
  });

  // --- Critère 3 : le solde vient du serveur, jamais calculé dans l'app ---------------------

  it('critère 3 -- un seul appel réseau, tous les montants viennent tels quels de la réponse', async () => {
    mockFetchCashSummary.mockResolvedValueOnce(cashResponse({ balance: 8400, marginRemaining: 6600, limit: 15000 }));
    await renderCash();

    expect(mockFetchCashSummary).toHaveBeenCalledTimes(1);
  });

  // --- Critère 4 : l'historique des remises affiche le statut, y compris contestée ----------

  it("critère 4 -- l'historique affiche date, montant, superviseur et statut, y compris une remise contestée", async () => {
    mockFetchCashSummary.mockResolvedValueOnce(
      cashResponse({
        remittances: [
          {
            id: 'validated-1',
            declaredAt: '2026-08-30T07:15:00Z',
            amount: 12000,
            countedAmount: 12000,
            status: 'validated',
            supervisorName: 'Awa Ngo',
          },
          {
            id: 'rejected-1',
            declaredAt: '2026-08-31T07:15:00Z',
            amount: 9000,
            countedAmount: 4000,
            status: 'rejected',
            supervisorName: 'Paul Eto',
          },
          {
            id: 'pending-1',
            declaredAt: '2026-09-01T07:15:00Z',
            amount: 8400,
            countedAmount: null,
            status: 'pending',
            supervisorName: null,
          },
        ],
      })
    );
    const { root } = await renderCash();

    expect(root.root.findByProps({ testID: 'cash-history-status-validated-1' }).props.children).toBe('Validée');
    expect(root.root.findByProps({ testID: 'cash-history-status-rejected-1' }).props.children).toBe('Contestée');
    expect(root.root.findByProps({ testID: 'cash-history-status-pending-1' }).props.children).toBe('En attente');
    expect(texts(root)).toContain('Awa Ngo');
  });

  it('sans aucune remise, un message le dit plutôt que de laisser la section vide', async () => {
    mockFetchCashSummary.mockResolvedValueOnce(cashResponse({ remittances: [] }));
    const { root } = await renderCash();

    expect(root.root.findByProps({ testID: 'cash-history-empty' })).toBeTruthy();
  });

  // --- Le bouton de déclaration de remise mène à l'écran de déclaration ---------------------

  it('le bouton de déclaration de remise navigue vers Remittance', async () => {
    mockFetchCashSummary.mockResolvedValueOnce(cashResponse());
    const { root, navigation } = await renderCash();

    await act(async () => {
      root.root.findByProps({ testID: 'cash-declare-remittance' }).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('Remittance');
  });

  // --- Rechargement au retour sur l'écran (après une déclaration) ---------------------------

  it('se recharge quand l’écran reprend le focus (retour depuis la déclaration de remise)', async () => {
    mockFetchCashSummary.mockResolvedValue(cashResponse());
    const navigation = fakeNavigation();
    await renderCash(navigation);

    expect(navigation.addListener).toHaveBeenCalledWith('focus', expect.any(Function));
    const focusHandler = navigation.addListener.mock.calls[0]?.[1] as (() => void) | undefined;
    await act(async () => {
      focusHandler?.();
    });

    expect(mockFetchCashSummary).toHaveBeenCalledTimes(2);
  });

  // --- Panne réseau : message d'erreur, pas un écran vide -----------------------------------

  it('une erreur réseau affiche un message et permet de réessayer', async () => {
    mockFetchCashSummary.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(cashResponse());
    const { root } = await renderCash();

    expect(root.root.findByProps({ testID: 'cash-error' })).toBeTruthy();

    await act(async () => {
      root.root.findByProps({ testID: 'cash-retry' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'cash-balance' })).toBeTruthy();
  });
});
