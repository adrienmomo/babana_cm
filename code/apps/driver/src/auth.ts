import { AuthClient, createHttpClient, secureTokenStorage, withTransparentRefresh } from '@babana/api-client';
import { API_BASE_URL } from '../config';

/**
 * Bootstrap d'authentification (L6-02) -- le seul endroit de l'app qui construit `AuthClient`.
 * Les écrans (`SignInScreen.tsx`) et le reste de l'app importent `authClient`/`apiClient` d'ici,
 * jamais `@babana/api-client` directement pour construire les leurs : une seule session, un seul
 * client HTTP authentifié par app. La configuration de Google Sign-In elle-même vit désormais
 * dans `./bootstrap.ts` (L6-00, critère d'acceptation 7 -- un seul point de configuration nommé,
 * plutôt qu'un effet de bord au chargement de ce fichier).
 */
const sessionLostListeners = new Set<() => void>();

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
  onSessionLost: () => sessionLostListeners.forEach((listener) => listener()),
});

/** Client HTTP à utiliser pour tout appel authentifié -- le renouvellement transparent (critères
 * d'acceptation 2 et 3, L6-02) y est déjà branché. */
export const apiClient = withTransparentRefresh(baseHttpClient, authClient);
