import { setBackgroundMessageHandler } from '@react-native-firebase/messaging';

// 15 novembre : une proposition reçue par Firebase app fermée sonne ; tout autre message, rien.

const mockAlert = jest.fn();
jest.mock('../../proposalAlert', () => ({
  configureProposalAlerts: jest.fn(),
  alertIncomingProposal: (...args: unknown[]) => mockAlert(...args),
}));
jest.mock('../../auth', () => ({ apiClient: { request: jest.fn() } }));
jest.mock('../handlers', () => ({ handleProposalPushMessage: jest.fn() }));

import { installBackgroundPushHandlers } from '../firebase';

test('une proposition reçue app fermée sonne jusqu’à son échéance', async () => {
  installBackgroundPushHandlers();
  const handler = (setBackgroundMessageHandler as jest.Mock).mock.calls[0][1] as (message: unknown) => Promise<void>;

  await handler({ data: { type: 'proposal', rideId: 'r1', expiresAt: '2026-11-15T12:00:30Z' } });
  expect(mockAlert).toHaveBeenCalledWith('2026-11-15T12:00:30Z');

  mockAlert.mockClear();
  await handler({ data: { type: 'ride', event: 'completed' } });
  expect(mockAlert).not.toHaveBeenCalled();
});
