import { http } from '@babana/contracts';
import { ApiError, type HttpClient } from '../http';
import type { StoredSession, TokenStorage } from './tokenStorage';

export type AuthUser = http.AuthSession['user'];

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  /** Epoch millisecondes. */
  expiresAt: number;
  user: AuthUser;
}

export interface AuthClientConfig {
  /** Client HTTP non authentifié à l'authentification elle-même -- /auth/refresh
   * et /auth/logout ne portent pas d'en-tête Authorization côté serveur (`_PUBLIC_AUTH_ROUTE`,
   * `controllers/auth.py`) ; ce client peut donc être le même que celui utilisé pour le reste de
   * l'app, `getAccessToken` n'y sera simplement jamais lu par ces trois endpoints. */
  httpClient: HttpClient;
  storage: TokenStorage;
  /** Appelé après une déconnexion propre déclenchée par un échec de renouvellement (critère
   * d'acceptation 3) -- c'est à l'app de réagir (retour à l'écran de connexion), pas à ce client
   * de connaître la navigation. */
  onSessionLost?: () => void;
}

function toAuthState(session: http.AuthSession, expiresAt: number): AuthState {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt,
    user: session.user,
  };
}

function expiresAtFromNow(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

/**
 * Session d'authentification (L6-02). Un seul point d'entrée d'une session obtenue du serveur
 * (`establishSession`), quel que soit l'appel qui l'a produite : les écrans ne stockent jamais
 * de jetons eux-mêmes. La connexion par OTP SMS (remplaçante de Google Sign-In) y déposera la
 * session que renvoie le serveur.
 */
export class AuthClient {
  private state: AuthState | null = null;

  constructor(private readonly config: AuthClientConfig) {}

  getAccessToken(): string | null {
    return this.state?.accessToken ?? null;
  }

  getUser(): AuthUser | null {
    return this.state?.user ?? null;
  }

  /** Recharge la session depuis le stockage sécurisé (démarrage de l'app) -- ne contacte jamais
   * le serveur : un jeton expiré est laissé tel quel, c'est `withTransparentRefresh` (ci-dessous)
   * qui le renouvellera au premier appel qui en a besoin. */
  async restore(): Promise<AuthState | null> {
    const stored = await this.config.storage.load();
    if (!stored) return null;
    // L'utilisateur (nom, photo, statut chauffeur) n'est pas persisté dans le trousseau -- ce
    // n'est pas un secret, et le premier appel authentifié le rafraîchira de toute façon depuis
    // le serveur si besoin. Restauré vide plutôt que fabriqué : un écran qui a besoin de `user`
    // avant le premier appel réseau doit le savoir, pas recevoir une valeur inventée.
    this.state = { ...stored, user: this.state?.user ?? EMPTY_USER };
    return this.state;
  }

  /** Demande l'envoi d'un code par SMS (`POST /auth/otp/request`). Renvoie l'identifiant de la
   * demande, à représenter avec le code. */
  async requestOtp(phoneNumber: string, role: 'client' | 'driver'): Promise<http.OtpRequestResponse> {
    return (await this.config.httpClient.request('authOtpRequest', {
      body: { phoneNumber, role } satisfies http.OtpRequestRequest,
    })) as http.OtpRequestResponse;
  }

  /** Échange le code reçu par SMS contre une session (`POST /auth/otp/verify`) et l'adopte. */
  async verifyOtp(verificationId: string, code: string): Promise<AuthState> {
    const session = (await this.config.httpClient.request('authOtpVerify', {
      body: { verificationId, code } satisfies http.OtpVerifyRequest,
    })) as http.OtpVerifyResponse;
    return this.applySession(session);
  }

  /** Adopte une session émise par le serveur : stockage sécurisé, puis état en mémoire. */
  async establishSession(session: http.AuthSession): Promise<AuthState> {
    return this.applySession(session);
  }

  /**
   * Rafraîchit `user` depuis `GET /me` (D35), sans toucher aux jetons -- appelé au démarrage
   * après `restore()`, à la place de l'ancien `refresh()` proactif détourné faute d'endpoint de
   * profil (voir `navigation/index.tsx` dans chacune des deux apps). `httpClient` doit être le
   * client enrobé de renouvellement transparent (`withTransparentRefresh`, pas
   * `this.config.httpClient` -- construit à partir de cette même instance à l'extérieur, donc
   * pas connu ici) : c'est lui qui fait du renouvellement une réaction à une expiration plutôt
   * qu'un appel systématique.
   */
  async refreshUser(httpClient: Pick<HttpClient, 'request'>): Promise<AuthState> {
    if (!this.state) {
      throw new Error('@babana/api-client: aucune session à rafraîchir (refreshUser() sans restore() préalable).');
    }
    const user = (await httpClient.request('me')) as http.MeResponse;
    this.state = { ...this.state, user };
    return this.state;
  }

  async refresh(): Promise<AuthState> {
    if (!this.state) {
      throw new Error('@babana/api-client: aucune session à renouveler (refresh() sans restore() préalable).');
    }
    const response = (await this.config.httpClient.request('authRefresh', {
      body: { refreshToken: this.state.refreshToken } satisfies http.RefreshRequest,
    })) as http.RefreshResponse;
    return this.applySession(response);
  }

  /** Déconnexion déclenchée par un échec de renouvellement (critère d'acceptation 3) --
   * `logout()` puis le rappel `onSessionLost`, dans cet ordre : l'app ne doit jamais voir
   * `onSessionLost` avant que la session locale ne soit réellement effacée. */
  async handleRefreshFailure(): Promise<void> {
    await this.logout();
    this.config.onSessionLost?.();
  }

  /** Déconnexion propre : révocation best-effort côté serveur (un réseau tombé ne doit pas
   * empêcher l'utilisateur de se déconnecter localement), puis effacement local systématique. */
  async logout(): Promise<void> {
    const refreshToken = this.state?.refreshToken;
    this.state = null;
    await this.config.storage.clear();
    if (refreshToken) {
      try {
        await this.config.httpClient.request('authLogout', {
          body: { refreshToken } satisfies http.LogoutRequest,
        });
      } catch {
        // Best-effort : la session locale est déjà effacée, ce qui compte pour l'utilisateur.
      }
    }
  }

  private async applySession(session: http.AuthSession): Promise<AuthState> {
    const stored: StoredSession = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: expiresAtFromNow(session.expiresIn),
    };
    await this.config.storage.save(stored);
    this.state = toAuthState(session, stored.expiresAt);
    return this.state;
  }
}

const EMPTY_USER: AuthUser = {
  id: '',
  role: 'client',
  displayName: '',
  photoUrl: null,
  phoneVerified: false,
};

/**
 * Renouvellement transparent (critère d'acceptation 2 et 3) : une requête qui échoue en
 * `TOKEN_EXPIRED` déclenche `refresh()` puis un réessai **unique** -- jamais de boucle, jamais un
 * second réessai sur le réessai. Si `refresh()` échoue à son tour (jeton de renouvellement
 * révoqué ou expiré), déconnexion propre (`logout()` + `onSessionLost`) et l'erreur d'origine est
 * relancée : l'appelant voit `TOKEN_EXPIRED`, jamais une exception de renouvellement qu'il ne
 * saurait pas interpréter.
 */
export function withTransparentRefresh(base: HttpClient, auth: AuthClient): HttpClient {
  return {
    async request(name, options) {
      try {
        return await base.request(name, options);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'TOKEN_EXPIRED') {
          throw error;
        }
        try {
          await auth.refresh();
        } catch {
          await auth.handleRefreshFailure();
          throw error;
        }
        return base.request(name, options);
      }
    },
  };
}
