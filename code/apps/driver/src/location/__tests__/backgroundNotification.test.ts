// La notification persistante de capture GPS (L6-05) : constaté sur émulateur le 21 octobre --
// « location-tracking-current » fait échouer react-native-push-notification sur Android
// (NumberFormatException : l'identifiant doit être un entier), donc la notification n'a jamais
// été postée. Même défaut que l'alerte de proposition (proposalAlert.test.ts), corrigé là-bas.
const mockLocalNotification = jest.fn();
const mockCancelLocalNotification = jest.fn();
jest.mock('react-native-push-notification', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    createChannel: jest.fn((_channel: unknown, callback?: (created: boolean) => void) => callback?.(true)),
    localNotification: (...args: unknown[]) => mockLocalNotification(...args),
    cancelLocalNotification: (...args: unknown[]) => mockCancelLocalNotification(...args),
  },
  Importance: { HIGH: 4, LOW: 2, DEFAULT: 3 },
}));

import { hideTrackingNotification, updateTrackingNotification } from '../background';
import { alertIncomingProposal } from '../../proposalAlert';

beforeEach(() => jest.clearAllMocks());

test("l'identifiant de la notification de capture est un entier sous forme de chaîne (exigence Android)", () => {
  updateTrackingNotification('Dernière position envoyée à l’instant');
  const { id } = mockLocalNotification.mock.calls[0][0] as { id: string };
  expect(id).toMatch(/^\d+$/);
  expect(Number.isSafeInteger(Number(id))).toBe(true);
});

test('elle est retirée avec le même identifiant, et ne se confond pas avec l’alerte de proposition', () => {
  updateTrackingNotification('x');
  hideTrackingNotification();
  const { id } = mockLocalNotification.mock.calls[0][0] as { id: string };
  expect(mockCancelLocalNotification).toHaveBeenCalledWith(id);

  alertIncomingProposal();
  const proposalId = (mockLocalNotification.mock.calls[1][0] as { id: string }).id;
  expect(proposalId).not.toBe(id);
});
