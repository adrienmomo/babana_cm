// Teste `../location.ts` (L6-06) en isolation, en contrôlant Platform.OS et PermissionsAndroid --
// le double automatique (__mocks__/@react-native-community/geolocation.js) sert les tests qui
// montent un écran sans se soucier de la position ; celui-ci vérifie le module lui-même.
let mockPlatformOS: 'ios' | 'android' = 'ios';
const mockPermissionRequest = jest.fn();
const mockGetCurrentPosition = jest.fn();
const mockRequestAuthorization = jest.fn();

jest.mock('react-native', () => ({
  get Platform() {
    return { OS: mockPlatformOS };
  },
  PermissionsAndroid: {
    request: (...args: unknown[]) => mockPermissionRequest(...args),
    PERMISSIONS: { ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
  },
}));

jest.mock('@react-native-community/geolocation', () => ({
  getCurrentPosition: (...args: unknown[]) => mockGetCurrentPosition(...args),
  requestAuthorization: (...args: unknown[]) => mockRequestAuthorization(...args),
}));

import { getCurrentPosition } from '../location';

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatformOS = 'ios';
});

describe('getCurrentPosition (L6-06)', () => {
  it('iOS : déclenche requestAuthorization puis renvoie la position obtenue', async () => {
    mockGetCurrentPosition.mockImplementation((success) => success({ coords: { latitude: 4.05, longitude: 9.7 } }));

    const result = await getCurrentPosition();

    expect(mockRequestAuthorization).toHaveBeenCalled();
    expect(result).toEqual({ latitude: 4.05, longitude: 9.7 });
  });

  it("l'échec de géolocalisation (refus, indisponible, délai dépassé) renvoie null, jamais une exception", async () => {
    mockGetCurrentPosition.mockImplementation((_success, error) => error(new Error('refusé')));

    await expect(getCurrentPosition()).resolves.toBeNull();
  });

  it('Android : demande la permission runtime avant tout appel de géolocalisation', async () => {
    mockPlatformOS = 'android';
    mockPermissionRequest.mockResolvedValue('granted');
    mockGetCurrentPosition.mockImplementation((success) => success({ coords: { latitude: 4.06, longitude: 9.71 } }));

    const result = await getCurrentPosition();

    expect(mockPermissionRequest).toHaveBeenCalledWith(
      'android.permission.ACCESS_FINE_LOCATION',
      expect.anything()
    );
    expect(result).toEqual({ latitude: 4.06, longitude: 9.71 });
  });

  it('Android : une permission refusée renvoie null sans jamais appeler la géolocalisation (spécification L6-06)', async () => {
    mockPlatformOS = 'android';
    mockPermissionRequest.mockResolvedValue('denied');

    const result = await getCurrentPosition();

    expect(result).toBeNull();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });
});
