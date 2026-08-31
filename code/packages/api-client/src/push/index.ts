import type { http } from '@babana/contracts';

/**
 * Enregistrement et cycle de vie du jeton d'appareil pour la notification push (L7-01).
 *
 * Le piège de L7-01 est le cycle de vie, pas l'intégration : ce module enregistre le jeton **à
 * la connexion** et **à chaque rotation** signalée par le système, et le désactive à la
 * déconnexion volontaire. Le nettoyage d'un jeton périmé, lui, se fait côté serveur sur retour
 * d'envoi de Firebase (`services/push.py`) -- pas ici, et jamais par un balayage.
 *
 * `@babana/api-client` ne dépend d'aucun SDK natif : la frontière avec Firebase/APNs est
 * l'interface `PushBinding`, **injectée** par l'app. Sans binding réel (l'environnement de nuit
 * ne produit aucun build mobile), `createUnavailablePushBinding()` échoue franchement -- jamais
 * un jeton inventé (principe D43), et `register()` le rapporte par sa valeur de retour plutôt
 * que par une exception, pour qu'un refus d'autorisation ne bloque aucun écran (L7-06).
 */

export type DevicePlatform = http.DevicePlatform;

export interface PushBinding {
  /** Demande l'autorisation d'afficher des notifications. `false` = refusée (l'app reste
   * utilisable, L7-06). */
  requestPermission(): Promise<boolean>;
  /** Jeton d'enregistrement courant, ou `null` s'il n'est pas encore disponible. */
  getToken(): Promise<string | null>;
  /** Rotation du jeton par le système. Retourne un désabonnement. */
  onTokenRefresh(listener: (token: string) => void): () => void;
}

/** Sous-ensemble du client REST dont ce module a besoin -- le `apiClient` de l'app le satisfait. */
export interface PushApiClient {
  request(name: string, options: { body: unknown }): Promise<unknown>;
}

export type PushRegistrationOutcome =
  | { registered: true; token: string }
  | {
      registered: false;
      reason: 'permission-denied' | 'no-token' | 'unavailable' | 'error';
      error?: unknown;
    };

export interface PushRegistrarConfig {
  apiClient: PushApiClient;
  binding: PushBinding;
  platform: DevicePlatform;
  /** Notifié des cas non bloquants (permission refusée, binding absent, échec d'un
   * ré-enregistrement après rotation) -- pour journalisation côté app, jamais fatal. */
  onNotice?: (outcome: PushRegistrationOutcome) => void;
}

export interface PushRegistrar {
  /** À la connexion : enregistre le jeton courant et s'abonne aux rotations. Ne rejette
   * jamais -- l'issue est dans la valeur de retour. */
  register(): Promise<PushRegistrationOutcome>;
  /** À la déconnexion volontaire de cet appareil : désactive le jeton côté serveur.
   * Best-effort, ne rejette jamais. */
  unregister(): Promise<void>;
  /** Arrête l'écoute des rotations (rappelé aussi au début de chaque `register()`). */
  dispose(): void;
}

/** Le binding lève ceci quand aucun SDK push n'est branché -- distinct d'une vraie erreur
 * d'exécution, pour que `register()` réponde `unavailable` et non `error`. */
export class PushBindingUnavailableError extends Error {
  constructor(message = 'Aucun SDK de notification push n’est branché (PushBinding absent).') {
    super(message);
    this.name = 'PushBindingUnavailableError';
  }
}

/** Binding par défaut, à remplacer par un vrai (Firebase/APNs) dans la session avec un
 * appareil. Échoue franchement -- ne renvoie jamais un jeton inventé (D43). */
export function createUnavailablePushBinding(reason?: string): PushBinding {
  const fail = (): never => {
    throw new PushBindingUnavailableError(
      reason ?? 'Aucun SDK de notification push n’est branché (PushBinding absent).'
    );
  };
  return {
    requestPermission: async () => fail(),
    getToken: async () => fail(),
    onTokenRefresh: () => fail(),
  };
}

export function createPushRegistrar(config: PushRegistrarConfig): PushRegistrar {
  const { apiClient, binding, platform, onNotice } = config;
  let unsubscribeRotation: (() => void) | null = null;
  let currentToken: string | null = null;

  function notice(outcome: PushRegistrationOutcome): PushRegistrationOutcome {
    if (!outcome.registered) onNotice?.(outcome);
    return outcome;
  }

  async function pushToken(token: string): Promise<void> {
    await apiClient.request('registerDeviceToken', {
      body: { token, platform } satisfies http.RegisterDeviceTokenRequest,
    });
  }

  function subscribeRotation(): void {
    if (unsubscribeRotation) return;
    unsubscribeRotation = binding.onTokenRefresh((token) => {
      currentToken = token;
      // Best-effort : une rotation qu'on n'arrive pas à pousser sera rattrapée au prochain
      // `register()` (prochaine ouverture de l'app).
      pushToken(token).catch((error: unknown) => {
        onNotice?.({ registered: false, reason: 'error', error });
      });
    });
  }

  return {
    async register() {
      dispose();
      let granted: boolean;
      try {
        granted = await binding.requestPermission();
      } catch (error) {
        if (error instanceof PushBindingUnavailableError) {
          return notice({ registered: false, reason: 'unavailable', error });
        }
        return notice({ registered: false, reason: 'error', error });
      }
      if (!granted) return notice({ registered: false, reason: 'permission-denied' });

      let token: string | null;
      try {
        token = await binding.getToken();
      } catch (error) {
        if (error instanceof PushBindingUnavailableError) {
          return notice({ registered: false, reason: 'unavailable', error });
        }
        return notice({ registered: false, reason: 'error', error });
      }
      if (!token) return notice({ registered: false, reason: 'no-token' });

      try {
        await pushToken(token);
      } catch (error) {
        return notice({ registered: false, reason: 'error', error });
      }

      currentToken = token;
      subscribeRotation();
      return { registered: true, token };
    },

    async unregister() {
      dispose();
      const token = currentToken;
      currentToken = null;
      if (!token) return;
      try {
        await apiClient.request('deactivateDeviceToken', {
          body: { token } satisfies http.DeactivateDeviceTokenRequest,
        });
      } catch {
        // Best-effort : si l'appel échoue, le serveur nettoiera de toute façon le jeton au
        // premier envoi qui reviendra invalide.
      }
    },

    dispose,
  };

  function dispose(): void {
    if (unsubscribeRotation) {
      unsubscribeRotation();
      unsubscribeRotation = null;
    }
  }
}
