import { ZodError } from 'zod';
import { ApiError } from '../http/errors';
import { generateIdempotencyKey } from '../http/idempotency';
import type { EndpointName, HttpClient, RequestOptions } from '../http/client';
import {
  OfflineActionQueue,
  createAsyncStorageOfflineQueue,
  type OfflineQueueStorage,
} from './queue';

/**
 * Rejoue une écriture autorisée hors connexion si le réseau manque, sans que l'écran appelant
 * n'ait à gérer lui-même une file, un redémarrage de l'app, ou une seconde tentative (L6-16,
 * critères 2, 4 et 6). Généralise le patron déjà écrit trois fois à la main
 * (`SettlementScreen.tsx`, `RemittanceScreen.tsx` -- voir leurs commentaires de tête, « la file
 * persistante qui survit à un redémarrage de l'app est L6-16 »).
 */
export interface OfflineActionRunnerConfig {
  httpClient: HttpClient;
  queueStorage?: OfflineQueueStorage;
}

export interface AttemptOptions extends RequestOptions {
  /**
   * Appelé de façon SYNCHRONE dès que l'action vient d'être mise en file (échec réseau) --
   * avant que la promesse retournée par `attempt()` ne se résolve, pour que l'écran appelant
   * puisse basculer son affichage en « en attente » tout de suite, sans attendre un succès qui
   * peut survenir bien plus tard (à la prochaine reconnexion, par `flush()`).
   */
  onQueued?: () => void;
}

/**
 * `httpClient.request(...)` porte déjà ses propres réessais réseau/serveur à court terme
 * (`client.ts`, critère 2 de L6-03 -- quelques secondes) : cette file ne prend le relais qu'une
 * fois CE budget épuisé, pour une coupure plus longue que ces réessais ne couvrent pas.
 */
export function createOfflineActionRunner(config: OfflineActionRunnerConfig) {
  const queue = new OfflineActionQueue(config.queueStorage ?? createAsyncStorageOfflineQueue());
  // Demandeurs encore en attente d'un rejeu réussi (ou d'un échec métier découvert au rejeu) --
  // vidé à chaque résolution. Un demandeur dont l'écran a été démonté avant la résolution est
  // simplement laissé sans auditeur : la file elle-même (persistante) survit à sa disparition,
  // c'est elle qui porte la garantie, pas ce registre en mémoire.
  const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

  /** Une erreur qui ne se rejouera jamais avec succès : une `ApiError` (catalogue C-01 -- l'état
   * serveur a tranché) ou une `ZodError` (réponse mal formée, `client.ts` -- même défaut à
   * chaque tentative). Tout le reste est traité comme un réseau absent. */
  function isDefinitive(error: unknown): boolean {
    return error instanceof ApiError || error instanceof ZodError;
  }

  async function attempt<Name extends EndpointName>(name: Name, options: AttemptOptions = {}): Promise<unknown> {
    const { onQueued, ...requestOptions } = options;
    const idempotencyKey = requestOptions.idempotencyKey ?? generateIdempotencyKey();
    const withKey: RequestOptions = { ...requestOptions, idempotencyKey };

    try {
      return await config.httpClient.request(name, withKey);
    } catch (error) {
      if (isDefinitive(error)) throw error;

      onQueued?.();
      await queue.enqueue({
        id: idempotencyKey,
        endpoint: name,
        options: { pathParams: withKey.pathParams, body: withKey.body, query: withKey.query },
        queuedAt: new Date().toISOString(),
      });

      return new Promise((resolve, reject) => {
        waiters.set(idempotencyKey, { resolve, reject });
      });
    }
  }

  /**
   * Rejoue la file dans l'ordre, une action à la fois (critère 6 : jamais deux à la fois avec
   * la même clé). Une tentative qui échoue encore pour une raison réseau arrête le rejeu -- le
   * réseau est probablement toujours absent, épuiser les tentatives suivantes en vain ne ferait
   * qu'attendre plus longtemps avant le prochain vrai essai (même choix que
   * `incident/offlineQueue.ts::flushPendingIncidentTriggers`). Une erreur métier découverte
   * seulement au rejeu (rare : l'état serveur a changé entre-temps) retire l'action -- la
   * rejouer indéfiniment ne la ferait jamais réussir.
   */
  async function flush(): Promise<void> {
    for (const action of await queue.list()) {
      const waiter = waiters.get(action.id);
      let result: unknown;
      try {
        result = await config.httpClient.request(action.endpoint as EndpointName, {
          ...action.options,
          idempotencyKey: action.id,
        });
      } catch (error) {
        if (isDefinitive(error)) {
          await queue.remove(action.id);
          waiter?.reject(error);
          waiters.delete(action.id);
          continue;
        }
        return;
      }
      await queue.remove(action.id);
      waiter?.resolve(result);
      waiters.delete(action.id);
    }
  }

  async function pendingCount(): Promise<number> {
    return (await queue.list()).length;
  }

  return { attempt, flush, pendingCount };
}

export type OfflineActionRunner = ReturnType<typeof createOfflineActionRunner>;
