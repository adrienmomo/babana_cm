const mockLogout = jest.fn();
jest.mock('../../config', () => ({ API_BASE_URL: 'https://api.test' }));
jest.mock('@babana/api-client', () => ({
  createHttpClient: () => ({ request: jest.fn() }),
  secureTokenStorage: {},
  withTransparentRefresh: (client: unknown) => client,
  AuthClient: class {
    logout = () => mockLogout();
  },
}));

import { onSessionLost, signOut } from '../auth';

describe('signOut -- déconnexion volontaire', () => {
  it('efface la session puis prévient les abonnés (garde d’authentification, temps réel), dans cet ordre', async () => {
    const order: string[] = [];
    mockLogout.mockImplementation(async () => {
      order.push('logout');
    });
    const unsubscribe = onSessionLost(() => order.push('session-lost'));

    await signOut();

    expect(order).toEqual(['logout', 'session-lost']);
    unsubscribe();
  });
});
