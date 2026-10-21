// L'alerte système de proposition (heads-up, son, vibration) : c'est ce qui prévient un chauffeur
// dont l'app est en arrière-plan. Constaté sur émulateur (21 octobre) : `react-native-push-notification`
// exige, sur Android, un identifiant de notification NUMÉRIQUE -- avec « proposal-alert-current » il
// journalise « failed to send push notification » (NumberFormatException) et ne poste rien, sans que
// l'app ne le sache : l'écran de proposition s'ouvrait, l'alerte jamais.
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
  Importance: { HIGH: 4 },
}));

import { alertIncomingProposal, dismissProposalAlert } from '../proposalAlert';

beforeEach(() => jest.clearAllMocks());

test("l'identifiant de l'alerte est un entier sous forme de chaîne (exigence Android de la bibliothèque)", () => {
  alertIncomingProposal();
  const { id } = mockLocalNotification.mock.calls[0][0] as { id: string };
  expect(id).toMatch(/^\d+$/);
  expect(Number.isSafeInteger(Number(id))).toBe(true);
});

test("l'alerte est retirée avec le même identifiant que celui sous lequel elle a été postée", () => {
  alertIncomingProposal();
  dismissProposalAlert();
  const { id } = mockLocalNotification.mock.calls[0][0] as { id: string };
  expect(mockCancelLocalNotification).toHaveBeenCalledWith(id);
});

test('l\'alerte réveille l\'appareil : son, vibration et priorité haute', () => {
  alertIncomingProposal();
  expect(mockLocalNotification.mock.calls[0][0]).toMatchObject({
    playSound: true,
    vibrate: true,
    priority: 'high',
    importance: 'high',
  });
});
