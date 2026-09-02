import type { RequestOptions } from '../http/client';

/**
 * File locale des écritures REST autorisées hors connexion (L6-16, critères 2 et 4) --
 * confirmation d'encaissement, fin de course, déclaration de remise, notation. Persistante,
 * rejouée dans l'ordre à la reconnexion, avec l'identifiant d'idempotence d'origine (voir
 * `manager.ts`) -- le serveur déduplique par cette clé (L4-03), un rejeu ne produit donc jamais
 * de double effet (critère 6).
 *
 * **Généralise `incident/offlineQueue.ts`**, qui documentait explicitement ne pas vouloir
 * généraliser `realtime/queue.ts` pour un seul consommateur (« un module minuscule qu'il est
 * plus sûr de dupliquer que d'étirer »). Ce motif ne tient plus une fois quatre écrans
 * (`SettlementScreen`, `ActiveRideScreen`, `RemittanceScreen`, `RideSummaryScreen`) à porter le
 * même besoin générique -- REST, une clé d'idempotence par action, rejeu dans l'ordre. La file
 * d'urgence (`incident/offlineQueue.ts`) reste telle quelle : elle porte des champs propres
 * (position, horodatage de déclenchement) que cette forme générique n'a pas à connaître, et la
 * retoucher n'apporterait rien ce soir.
 *
 * **Ce que cette file ne connaît PAS** (même discipline que `realtime/queue.ts`) : `nearby.*`,
 * `ride.track`, `position.update` (WebSocket, jamais REST) ; `selectDriver`, `proposal.accept`,
 * `proposal.reject` (interdits hors connexion, spécification L6-16) -- ces derniers ne
 * transitent jamais par ce module, l'écran appelant refuse l'action lui-même avant d'y songer
 * (voir `ProposalScreen.tsx`, `QuoteScreen.tsx`).
 */
export interface QueuedHttpAction {
  /** Clé d'idempotence -- posée une fois à la mise en file, réutilisée sur chaque tentative de
   * rejeu (voir `manager.ts::attempt`). */
  id: string;
  /** Nom d'endpoint du registre `HTTP_ENDPOINTS` (@babana/contracts) -- gardé en `string` plutôt
   * qu'en `EndpointName` : ce module ne connaît que ce qu'on lui donne à stocker, `manager.ts`
   * porte la contrainte de type côté appelant. */
  endpoint: string;
  options: Pick<RequestOptions, 'pathParams' | 'body' | 'query'>;
  queuedAt: string;
}

export interface OfflineQueueStorage {
  load(): Promise<QueuedHttpAction[]>;
  save(actions: QueuedHttpAction[]): Promise<void>;
}

const STORAGE_KEY = 'cm.babana.offline.action-queue';

/** `AsyncStorage`, même choix que `realtime/queue.ts` et `incident/offlineQueue.ts` pour la même
 * raison : ces actions ne sont pas des secrets (un montant déjà affiché à l'écran, un identifiant
 * de course), et le trousseau sécurisé est pensé pour de petites valeurs uniques, pas une liste
 * qui grandit et rétrécit. Import différé (même réflexe que les deux modules ci-dessus) : ne
 * jamais gêner un consommateur qui ne s'en sert jamais. */
export function createAsyncStorageOfflineQueue(): OfflineQueueStorage {
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;

  return {
    async load() {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as QueuedHttpAction[]) : [];
      } catch {
        return [];
      }
    },
    async save(actions: QueuedHttpAction[]) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
    },
  };
}

/** En mémoire seulement -- tests, ou un appelant qui choisirait explicitement de ne rien
 * persister. `createAsyncStorageOfflineQueue` reste le choix par défaut de `manager.ts`
 * (critère 4). */
export function createInMemoryOfflineQueue(): OfflineQueueStorage {
  let actions: QueuedHttpAction[] = [];
  return {
    async load() {
      return actions;
    },
    async save(next: QueuedHttpAction[]) {
      actions = next;
    },
  };
}

export class OfflineActionQueue {
  /** Chaîne les accès en écriture -- même mutex minimal que `realtime/queue.ts` et
   * `incident/offlineQueue.ts` (voir leurs commentaires pour le raisonnement complet : deux
   * `enqueue()` rapprochés, sans `await` entre les deux, entrelaceraient sinon leur propre
   * `load()`/`save()` et le second écraserait le premier). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: OfflineQueueStorage) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  enqueue(action: QueuedHttpAction): Promise<void> {
    return this.serialize(async () => {
      const current = await this.storage.load();
      await this.storage.save([...current, action]);
    });
  }

  list(): Promise<QueuedHttpAction[]> {
    return this.serialize(() => this.storage.load());
  }

  /** Retire une action rejouée avec succès -- une par une (voir `manager.ts::flush`), pas en un
   * seul `clear()` global : une reconnexion coupée en cours de rejeu ne doit pas perdre les
   * actions qui restaient à envoyer. */
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const current = await this.storage.load();
      await this.storage.save(current.filter((action) => action.id !== id));
    });
  }
}
