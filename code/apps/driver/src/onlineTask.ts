import type { realtime } from '@babana/contracts';
import { bootstrap } from './bootstrap';
import { authClient } from './auth';
import { ensureRealtimeConnected, onRealtimeMessage } from './realtime';
import { locationTracker } from './location';
import { hideTrackingNotification, untilTrackingStops } from './location/background';

/**
 * Tâche JS du service de premier plan d'un chauffeur en ligne (`BabanaDriverOnline`, décision du
 * 14 novembre -- `android/.../online/OnlineService.kt`). Elle ne fait presque rien : elle EXISTE,
 * et tant qu'elle existe React Native garde les minuteurs JS actifs hors de l'écran -- la capture
 * (3 s en course, 5 s en mouvement, 15 s immobile), le battement de cœur du WebSocket, l'alerte de proposition.
 *
 * Deux façons d'arriver ici :
 * - le cas courant : le chauffeur passe en ligne, app à l'écran -- tout est déjà démarré, les
 *   appels ci-dessous sont idempotents ;
 * - Android a tué puis relancé le processus (le service redémarre de lui-même) : aucun écran n'a
 *   démarré quoi que ce soit. La session est relue, la connexion rouverte, et c'est le serveur qui
 *   dit si le chauffeur est encore en ligne (`session.synced.driverOnline`) -- jamais cette tâche.
 */
export async function onlineHeadlessTask(deps: OnlineTaskDeps = defaultDeps): Promise<void> {
  deps.bootstrap();
  const coldStart = !deps.hasUser();
  if (coldStart) {
    const restored = await deps.restoreSession().catch(() => false);
    if (!restored) {
      // Plus de session : rien à garder en ligne.
      deps.stopTracking();
      return;
    }
  }
  const stopped = deps.untilTrackingStops();
  // App vivante, et le chauffeur déjà repassé hors ligne avant que cette tâche ne démarre (bascule
  // rapide) : le service n'a plus de raison d'être, ne pas l'attendre indéfiniment.
  if (!coldStart && !deps.isTracking()) deps.stopTracking();
  const unsubscribe = deps.onMessage((message) => {
    // Le serveur ne tient plus ce chauffeur en ligne (période de grâce dépassée pendant que le
    // processus était mort) : la capture n'a jamais redémarré, seul le service reste à arrêter.
    if (message.type === 'session.synced' && message.payload.driverOnline === false && !deps.isTracking()) {
      deps.stopTracking();
    }
  });
  deps.connect();
  await stopped;
  unsubscribe();
}

export interface OnlineTaskDeps {
  bootstrap: () => void;
  hasUser: () => boolean;
  restoreSession: () => Promise<boolean>;
  connect: () => void;
  onMessage: (listener: (message: realtime.ServerToClientMessage) => void) => () => void;
  isTracking: () => boolean;
  stopTracking: () => void;
  untilTrackingStops: () => Promise<void>;
}

const defaultDeps: OnlineTaskDeps = {
  bootstrap,
  hasUser: () => authClient.getUser() !== null,
  restoreSession: async () => (await authClient.restore()) !== null,
  connect: ensureRealtimeConnected,
  onMessage: onRealtimeMessage,
  isTracking: () => locationTracker.getState() !== 'offline',
  stopTracking: hideTrackingNotification,
  untilTrackingStops,
};
