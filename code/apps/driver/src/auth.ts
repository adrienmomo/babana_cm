import { AuthClient, createHttpClient, secureTokenStorage, withTransparentRefresh, type SessionLossReason } from '@babana/api-client';
import { API_BASE_URL } from '../config';

/**
 * Bootstrap d'authentification (L6-02) -- le seul endroit de l'app qui construit `AuthClient`.
 * Les écrans (`SignInScreen.tsx`) et le reste de l'app importent `authClient`/`apiClient` d'ici,
 * jamais `@babana/api-client` directement pour construire les leurs : une seule session, un seul
 * client HTTP authentifié par app.
 */
const sessionLostListeners = new Set<() => void>();

/** Pourquoi la dernière session s'est fermée, lu une fois par l'écran de connexion (15 novembre). */
let lastSessionLossReason: SessionLossReason | null = null;

export const SESSION_REPLACED_NOTICE = 'Votre compte a été connecté sur un autre téléphone.';

/** Le message à montrer sur l'écran de connexion après une session fermée par le serveur, une fois. */
export function takeSessionLossNotice(): string | null {
  const reason = lastSessionLossReason;
  lastSessionLossReason = null;
  return reason === 'replaced' ? SESSION_REPLACED_NOTICE : null;
}

/** `onSessionLost` (L6-02) diffusé aux abonnés -- la garde d'authentification (L6-00,
 * `src/navigation/index.tsx`) s'y abonne pour démonter les écrans métier et remonter la
 * connexion, quel que soit l'écran affiché au moment de la perte de session. */
export function onSessionLost(listener: () => void): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

const baseHttpClient = createHttpClient({
  baseUrl: API_BASE_URL,
  getAccessToken: () => authClient.getAccessToken(),
});

export const authClient = new AuthClient({
  httpClient: baseHttpClient,
  storage: secureTokenStorage,
  onSessionLost: (reason) => {
    lastSessionLossReason = reason ?? null;
    sessionLostListeners.forEach((listener) => listener());
  },
});

/** Client HTTP à utiliser pour tout appel authentifié -- le renouvellement transparent (critères
 * d'acceptation 2 et 3, L6-02) y est déjà branché. */
export const apiClient = withTransparentRefresh(baseHttpClient, authClient);

/** Déconnexion volontaire (écran de profil) : révocation best-effort et effacement local
 * (`logout()`), puis les mêmes abonnés que pour une session perdue -- la garde d'authentification
 * remonte la connexion, le temps réel se ferme. */
export async function signOut(): Promise<void> {
  await authClient.logout();
  sessionLostListeners.forEach((listener) => listener());
}
