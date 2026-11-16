import { AppState, NativeModules } from 'react-native';

// 15 novembre (point 9) : icône flottante du chauffeur en ligne, app en arrière-plan ; une
// proposition reçue app cachée ramène l'app au premier plan.

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
}));
jest.mock('../location', () => ({ locationTracker: { isOnline: () => false, subscribeOnline: jest.fn() } }));

const bubble = {
  canDrawOverlays: jest.fn(),
  openPermissionSettings: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
  bringToFront: jest.fn(),
};
(NativeModules as Record<string, unknown>).BabanaFloatingBubble = bubble;

import { askOverlayPermissionOnce, bringAppToFront, shouldShowBubble } from '../floatingBubble';

beforeEach(() => {
  mockStore.clear();
  Object.values(bubble).forEach((fn) => fn.mockReset());
});

test('la bulle se montre en ligne, app hors de l’écran -- jamais hors ligne, jamais app ouverte', () => {
  expect(shouldShowBubble('background', true)).toBe(true);
  expect(shouldShowBubble('inactive', true)).toBe(true);
  expect(shouldShowBubble('active', true)).toBe(false);
  expect(shouldShowBubble('background', false)).toBe(false);
});

test('l’autorisation est demandée une seule fois, et jamais si elle est déjà accordée', async () => {
  bubble.canDrawOverlays.mockResolvedValue(false);
  await askOverlayPermissionOnce();
  await askOverlayPermissionOnce();
  expect(bubble.openPermissionSettings).toHaveBeenCalledTimes(1);

  mockStore.clear();
  bubble.openPermissionSettings.mockReset();
  bubble.canDrawOverlays.mockResolvedValue(true);
  await askOverlayPermissionOnce();
  expect(bubble.openPermissionSettings).not.toHaveBeenCalled();
});

test('une proposition app cachée ramène l’app ; app à l’écran, rien', () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
  bringAppToFront();
  expect(bubble.bringToFront).toHaveBeenCalledTimes(1);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  bringAppToFront();
  expect(bubble.bringToFront).toHaveBeenCalledTimes(1);
});
