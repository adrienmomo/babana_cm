import type { realtime } from '@babana/contracts';
import { handleSessionReplacedMessage } from '../sessionReplaced';

// 15 novembre : le compte s'est connecté sur un autre téléphone ; celui-ci oublie sa session.

const message = (type: string) => ({ type, id: 'm', emittedAt: '2026-11-15T12:00:00Z', payload: {} }) as unknown as realtime.ServerToClientMessage;

test('session.replaced : la session locale est oubliée', async () => {
  const forgetSession = jest.fn().mockResolvedValue(undefined);
  await expect(handleSessionReplacedMessage(message('session.replaced'), { forgetSession })).resolves.toBe(true);
  expect(forgetSession).toHaveBeenCalledTimes(1);
});

test('tout autre message est ignoré', async () => {
  const forgetSession = jest.fn();
  await expect(handleSessionReplacedMessage(message('session.synced'), { forgetSession })).resolves.toBe(false);
  expect(forgetSession).not.toHaveBeenCalled();
});
