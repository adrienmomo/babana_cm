// Le contenu de cash.ts (L5-07) est mocké dans CashScreen.test.tsx / RemittanceScreen.test.tsx --
// ce fichier est la seule preuve que l'enveloppe appelle réellement les bons endpoints du
// contrat, avec les bons arguments (les tests d'écran ne l'exercent jamais).
const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// `offlineRunner` réel, branché sur le même `mockRequest` (même topologie qu'en production :
// `../offline.ts` enrobe `apiClient`) -- `declareRemittance` (L6-16) passe par lui depuis ce
// soir. Voir SettlementScreen.test.tsx pour le raisonnement complet sur ce patron de test.
jest.mock('../../offline', () => ({
  offlineRunner: require('@babana/api-client').createOfflineActionRunner({
    httpClient: { request: (...args: unknown[]) => mockRequest(...args) },
    queueStorage: require('@babana/api-client').createInMemoryOfflineQueue(),
  }),
}));

import { declareRemittance, fetchCashSummary } from '../cash';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('api/cash.ts (L5-07)', () => {
  it('fetchCashSummary appelle GET driverCash sans argument', async () => {
    const response = {
      balance: 8400,
      limit: 15000,
      marginRemaining: 6600,
      collectedToday: 8400,
      remittances: [],
    };
    mockRequest.mockResolvedValueOnce(response);

    const result = await fetchCashSummary();

    expect(mockRequest).toHaveBeenCalledWith('driverCash');
    expect(result).toBe(response);
  });

  it('declareRemittance appelle createRemittance avec le montant et une clé d’idempotence (L6-16)', async () => {
    const response = { id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 };
    mockRequest.mockResolvedValueOnce(response);

    const result = await declareRemittance(8400);

    expect(mockRequest).toHaveBeenCalledWith(
      'createRemittance',
      expect.objectContaining({ body: { amount: 8400 }, idempotencyKey: expect.any(String) })
    );
    expect(result).toBe(response);
  });

  it('declareRemittance hors connexion : appelle onQueued, met en file, rejoue avec la même clé (L6-16)', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 });
    let queued = false;

    const pending = declareRemittance(8400, () => {
      queued = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(queued).toBe(true);

    const { offlineRunner } = require('../../offline');
    await offlineRunner.flush();
    const result = await pending;

    expect(result).toEqual({ id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 });
    const calls = mockRequest.mock.calls.filter((c: unknown[]) => c[0] === 'createRemittance');
    expect(calls).toHaveLength(2);
    expect(calls[0][1].idempotencyKey).toBe(calls[1][1].idempotencyKey);
  });
});
