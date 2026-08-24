import { randomUUID } from '../uuid';

/**
 * File locale des déclenchements du bouton d'urgence non encore confirmés par le serveur
 * (L8-04, critère d'acceptation 6). Volontairement dédiée -- pas une généralisation de
 * `realtime/queue.ts::ActionQueue`, qui documente explicitement ne connaître que les messages
 * WebSocket rejoués à la reconnexion (`ce module ne connaît que les autres types de message,
 * il n'a même pas besoin de savoir que position.update existe`) : forcer un déclenchement REST
 * hors connexion dans ce contrat aurait plié une portée déjà explicite, pour un module minuscule
 * (une quinzaine de lignes) qu'il est plus sûr de dupliquer que d'étirer.
 *
 * `idempotencyKey` est posé UNE fois, à la mise en file -- réutilisé sur chaque tentative de
 * soumission (voir `submitOrQueue` ci-dessous et `client.request(..., { idempotencyKey })`,
 * L8-04) : sans cette clé stable, une tentative qui aurait réellement atteint le serveur avant
 * qu'un signal réseau ne se perde produirait un second incident au prochain essai.
 */
export interface PendingIncidentTrigger {
  idempotencyKey: string;
  rideId: string;
  latitude: number;
  longitude: number;
  /** ISO 8601, posé au moment du déclenchement -- jamais recalculé au moment de l'envoi
   * (critère d'acceptation 2 : "enregistre la position exacte", au sens du moment exact aussi). */
  triggeredAt: string;
}

export interface PendingIncidentStorage {
  load(): Promise<PendingIncidentTrigger[]>;
  save(pending: PendingIncidentTrigger[]): Promise<void>;
}

const STORAGE_KEY = 'cm.babana.incident.pending-triggers';

/** `AsyncStorage`, même choix que `realtime/queue.ts` pour la même raison : une position/un
 * identifiant de course déjà visibles côté app, pas un secret qui exigerait le trousseau. */
export function createAsyncStoragePendingIncidentQueue(): PendingIncidentStorage {
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  return {
    async load() {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as PendingIncidentTrigger[]) : [];
      } catch {
        return [];
      }
    },
    async save(pending: PendingIncidentTrigger[]) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    },
  };
}

export function createInMemoryPendingIncidentQueue(): PendingIncidentStorage {
  let pending: PendingIncidentTrigger[] = [];
  return {
    async load() {
      return pending;
    },
    async save(next) {
      pending = next;
    },
  };
}

export class PendingIncidentQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: PendingIncidentStorage) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  enqueue(trigger: Omit<PendingIncidentTrigger, 'idempotencyKey'>): Promise<PendingIncidentTrigger> {
    return this.serialize(async () => {
      const withKey: PendingIncidentTrigger = { ...trigger, idempotencyKey: randomUUID() };
      const current = await this.storage.load();
      await this.storage.save([...current, withKey]);
      return withKey;
    });
  }

  list(): Promise<PendingIncidentTrigger[]> {
    return this.serialize(() => this.storage.load());
  }

  remove(idempotencyKey: string): Promise<void> {
    return this.serialize(async () => {
      const current = await this.storage.load();
      await this.storage.save(current.filter((trigger) => trigger.idempotencyKey !== idempotencyKey));
    });
  }
}

/**
 * Rejoue la file dans l'ordre, une par une -- une tentative qui échoue encore arrête le
 * rejoue (le réseau est probablement toujours absent), plutôt que d'épuiser les tentatives
 * suivantes en vain. `submit` est fourni par l'appelant (l'écran ne connaît que
 * `client.request('triggerIncident', ...)`, ce module ne connaît pas `@babana/contracts`).
 */
export async function flushPendingIncidentTriggers(
  queue: PendingIncidentQueue,
  submit: (trigger: PendingIncidentTrigger) => Promise<boolean>
): Promise<void> {
  const pending = await queue.list();
  for (const trigger of pending) {
    const succeeded = await submit(trigger).catch(() => false);
    if (!succeeded) return;
    await queue.remove(trigger.idempotencyKey);
  }
}
