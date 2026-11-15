import type { realtime } from '@babana/contracts';
import { authClient } from './auth';
import { onRealtimeMessage } from './realtime';

/**
 * Un appareil par chauffeur (15 novembre) : le compte s'est connecté sur un autre téléphone. Le
 * serveur le dit (`session.replaced`) puis ferme la connexion ; ce téléphone oublie sa session --
 * localement seulement : ni passage hors ligne, ni `/auth/logout`, le chauffeur continue sur
 * l'autre téléphone, course comprise. L'écran de connexion dit pourquoi.
 *
 * Indépendant des écrans (comme `proposalWatch.ts`) : actif aussi app fermée, dans la tâche du
 * service de premier plan -- c'est là qu'un ancien téléphone resté en ligne l'apprend.
 */

export interface SessionReplacedDeps {
  forgetSession(): Promise<void>;
}

const defaultDeps: SessionReplacedDeps = {
  forgetSession: () => authClient.forgetSession('replaced'),
};

export async function handleSessionReplacedMessage(
  message: realtime.ServerToClientMessage,
  deps: SessionReplacedDeps = defaultDeps
): Promise<boolean> {
  if (message.type !== 'session.replaced') return false;
  await deps.forgetSession();
  return true;
}

let started = false;

/** Point d'accroche unique (`bootstrap.ts`). Idempotent. */
export function startSessionReplacedWatch(): void {
  if (started) return;
  started = true;
  onRealtimeMessage((message) => {
    handleSessionReplacedMessage(message).catch(() => undefined);
  });
}
