import { realtime } from '@babana/contracts';

/**
 * File d'attente locale des actions émises hors connexion (L6-04, critères 2 et 3 ; L3-11).
 * Rejouées dans l'ordre à la reconnexion, avec leur identifiant d'origine (`id` de l'enveloppe,
 * voir `connection.ts`) -- le serveur déduplique par cet identifiant (L3-07), un rejeu ne produit
 * donc jamais de double effet.
 *
 * **Les positions n'y entrent jamais** (critère 4) : `connection.ts` les traite à part (seule la
 * dernière compte, jamais une file qui grandit). Ce module ne connaît que les autres types de
 * message -- il n'a même pas besoin de savoir que `position.update` existe.
 *
 * **Les déclarations d'intérêt courant non plus** (L3-20, 24 août) : `nearby.subscribe`,
 * `nearby.unsubscribe`, `ride.track` sont déjà réémises par l'écran appelant à chaque `connected`
 * -- les mettre en file les rejouait une seconde fois, avec des paramètres capturés à l'émission
 * d'origine, potentiellement périmés au moment du rejeu (cause racine du silence de diffusion du
 * 30 août, `amoa/questions/L3-05-nearby-list-goes-silently-empty.md`). Voir `connection.ts`,
 * `NEVER_QUEUED_MESSAGE_TYPES`.
 */
export interface QueuedAction {
  /** Même valeur que `id` dans l'enveloppe WebSocket envoyée -- l'identité du rejeu. */
  id: string;
  type: Exclude<realtime.ClientToServerMessage['type'], 'position.update' | 'nearby.subscribe' | 'nearby.unsubscribe' | 'ride.track'>;
  payload: unknown;
  queuedAt: string;
}

/** Interface d'injection -- testable sans stockage réel (même discipline que `TokenStorage`,
 * L6-02). */
export interface ActionQueueStorage {
  load(): Promise<QueuedAction[]>;
  save(actions: QueuedAction[]): Promise<void>;
}

const STORAGE_KEY = 'cm.babana.realtime.action-queue';

/**
 * `AsyncStorage`, pas le trousseau sécurisé (`react-native-keychain`, L6-02) : ces actions ne
 * sont pas des secrets (des identifiants de course, des montants déjà visibles côté app), et le
 * trousseau est pensé pour de petites valeurs uniques, pas une liste qui grandit et rétrécit.
 */
export function createAsyncStorageActionQueue(): ActionQueueStorage {
  // Import différé : ce module ne doit pas faire échouer le chargement de tout le paquet sur une
  // plateforme qui n'aurait pas encore lié le module natif (même réflexe que `tokenStorage.ts`
  // pour le trousseau, où l'import est en tête de fichier parce que la dépendance est déjà
  // linkée -- ici, chargé au premier appel réel plutôt qu'au chargement du module, pour ne
  // jamais gêner un consommateur qui ne s'en sert jamais, ex. la file n'est instanciée qu'à
  // l'initialisation de `createRealtimeClient`).
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;

  return {
    async load() {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as QueuedAction[]) : [];
      } catch {
        return [];
      }
    },
    async save(actions: QueuedAction[]) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
    },
  };
}

/**
 * En mémoire seulement -- appelants qui n'ont pas besoin de survivre à un redémarrage (tests,
 * ou une app qui choisirait explicitement de ne rien persister). `createAsyncStorageActionQueue`
 * reste le choix par défaut de `createRealtimeClient` (critère 3).
 */
export function createInMemoryActionQueue(): ActionQueueStorage {
  let actions: QueuedAction[] = [];
  return {
    async load() {
      return actions;
    },
    async save(next: QueuedAction[]) {
      actions = next;
    },
  };
}

export class ActionQueue {
  /**
   * Chaîne les accès en écriture (`enqueue`/`remove`) pour qu'ils s'exécutent strictement l'un
   * après l'autre -- sans cela, deux appels rapprochés (deux `client.send()` de suite, aucun
   * `await` entre les deux : `connection.ts` ne rend pas `send()` asynchrone) entrelacent leur
   * propre `load()`/`save()` et le second écrase le premier plutôt que de l'accumuler. Constaté
   * en écrivant le test "rejouée dans l'ordre" : la seconde action arrivait seule. Un mutex
   * minimal en une ligne, pas une dépendance nouvelle pour ça.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: ActionQueueStorage) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  enqueue(action: QueuedAction): Promise<void> {
    return this.serialize(async () => {
      const current = await this.storage.load();
      await this.storage.save([...current, action]);
    });
  }

  list(): Promise<QueuedAction[]> {
    return this.serialize(() => this.storage.load());
  }

  /** Retire une action rejouée avec succès -- appelée une par une pendant le rejeu
   * (`connection.ts`), pas en un seul `clear()` global : une reconnexion coupée en cours de
   * rejeu ne doit pas perdre les actions qui restaient à envoyer. */
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const current = await this.storage.load();
      await this.storage.save(current.filter((action) => action.id !== id));
    });
  }
}
