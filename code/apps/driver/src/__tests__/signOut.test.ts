import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
const mockSignOut = jest.fn();
jest.mock('../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
  signOut: () => mockSignOut(),
}));

const mockSend = jest.fn();
jest.mock('../realtime', () => ({
  realtimeClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

let mockTrackerState: 'offline' | 'idle' | 'ride' = 'offline';
const mockSetOnline = jest.fn();
jest.mock('../location', () => ({
  locationTracker: {
    getState: () => mockTrackerState,
    setOnline: (online: boolean) => mockSetOnline(online),
  },
}));

import { signOutDriver } from '../signOut';

afterEach(() => {
  jest.clearAllMocks();
  mockTrackerState = 'offline';
});

describe('signOutDriver -- déconnexion volontaire du chauffeur', () => {
  it('hors ligne : déconnecte directement, sans rien demander au serveur', async () => {
    mockSignOut.mockResolvedValue(undefined);

    await expect(signOutDriver()).resolves.toEqual({ signedOut: true });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('en ligne : passe hors ligne d’abord (Odoo puis temps réel), puis déconnecte -- un chauffeur déconnecté ne reste pas dans le vivier', async () => {
    mockTrackerState = 'idle';
    const order: string[] = [];
    mockRequest.mockImplementation(async () => {
      order.push('setAvailability');
      return { online: false };
    });
    mockSend.mockImplementation(() => order.push('availability.set'));
    mockSetOnline.mockImplementation(() => order.push('tracker'));
    mockSignOut.mockImplementation(async () => {
      order.push('signOut');
    });

    await expect(signOutDriver()).resolves.toEqual({ signedOut: true });

    expect(mockRequest).toHaveBeenCalledWith('setAvailability', { body: { online: false } });
    expect(mockSend).toHaveBeenCalledWith('availability.set', { online: false });
    expect(mockSetOnline).toHaveBeenCalledWith(false);
    expect(order).toEqual(['setAvailability', 'availability.set', 'tracker', 'signOut']);
  });

  it('refus du serveur (course en cours) : rien n’est déconnecté, le motif est rendu', async () => {
    mockTrackerState = 'ride';
    mockRequest.mockRejectedValue(new ApiError('DRIVER_HAS_ACTIVE_RIDE', 'active ride', 409));

    const outcome = await signOutDriver();

    expect(outcome.signedOut).toBe(false);
    expect(outcome.signedOut === false && outcome.message.length).toBeGreaterThan(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('sans réseau : la déconnexion locale reste possible (le serveur retire du vivier après la période de grâce)', async () => {
    mockTrackerState = 'idle';
    mockRequest.mockRejectedValue(new TypeError('Network request failed'));
    mockSignOut.mockResolvedValue(undefined);

    await expect(signOutDriver()).resolves.toEqual({ signedOut: true });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
