// Le contenu de cash.ts (L5-07) est mocké dans CashScreen.test.tsx / RemittanceScreen.test.tsx --
// ce fichier est la seule preuve que l'enveloppe appelle réellement les bons endpoints du
// contrat, avec les bons arguments (les tests d'écran ne l'exercent jamais).
const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
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

  it('declareRemittance appelle createRemittance avec le montant et la clé d’idempotence', async () => {
    const response = { id: 'r1', amount: 8400, status: 'pending', driverCashBalance: 0 };
    mockRequest.mockResolvedValueOnce(response);

    const result = await declareRemittance(8400, 'idem-key-1');

    expect(mockRequest).toHaveBeenCalledWith('createRemittance', {
      body: { amount: 8400 },
      idempotencyKey: 'idem-key-1',
    });
    expect(result).toBe(response);
  });
});
