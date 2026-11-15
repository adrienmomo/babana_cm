// Décision du 14 novembre : sur Android, la notification de capture est celle d'un vrai service de
// premier plan (android/.../online/OnlineService.kt) -- c'est lui qui garde le chauffeur en ligne
// app fermée. Ce fichier vérifie le pont JS : le service est démarré/mis à jour par la même
// fonction que la notification, arrêté avec elle, et la tâche JS qu'il porte se termine alors.
const mockShow = jest.fn();
const mockHide = jest.fn();
const mockLocalNotification = jest.fn();
const mockCancelLocalNotification = jest.fn();

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { BabanaOnlineService: { show: (...a: unknown[]) => mockShow(...a), hide: () => mockHide() } },
}));
jest.mock('react-native-push-notification', () => ({
  __esModule: true,
  default: {
    createChannel: jest.fn(),
    localNotification: (...a: unknown[]) => mockLocalNotification(...a),
    cancelLocalNotification: (...a: unknown[]) => mockCancelLocalNotification(...a),
  },
  Importance: { LOW: 2 },
}));

import { hideTrackingNotification, untilTrackingStops, updateTrackingNotification } from '../background';

beforeEach(() => jest.clearAllMocks());

test('Android : la notification de capture passe par le service natif, jamais par une notification locale', () => {
  updateTrackingNotification('Dernière position envoyée à l’instant.');
  expect(mockShow).toHaveBeenCalledWith('Dernière position envoyée à l’instant.');
  expect(mockLocalNotification).not.toHaveBeenCalled();
});

test('le passage hors ligne arrête le service et termine la tâche JS qui l’attendait', async () => {
  updateTrackingNotification('x');
  let stopped = false;
  const task = untilTrackingStops().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);

  hideTrackingNotification();
  await task;
  expect(mockHide).toHaveBeenCalledTimes(1);
  expect(mockCancelLocalNotification).not.toHaveBeenCalled();
  expect(stopped).toBe(true);
});
