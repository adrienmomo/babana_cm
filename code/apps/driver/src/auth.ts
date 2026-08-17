import {
  AuthClient,
  configureGoogleSignIn,
  createHttpClient,
  secureTokenStorage,
  withTransparentRefresh,
} from '@babana/api-client';
import { API_BASE_URL, GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '../config';

/**
 * Bootstrap d'authentification (L6-02) -- le seul endroit de l'app qui construit `AuthClient` et
 * configure Google Sign-In. Les écrans (`SignInScreen.tsx`) et le reste de l'app importent
 * `authClient`/`apiClient` d'ici, jamais `@babana/api-client` directement pour construire les
 * leurs : une seule session, un seul client HTTP authentifié par app.
 */
configureGoogleSignIn({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });

const baseHttpClient = createHttpClient({
  baseUrl: API_BASE_URL,
  getAccessToken: () => authClient.getAccessToken(),
});

export const authClient = new AuthClient({
  httpClient: baseHttpClient,
  storage: secureTokenStorage,
});

/** Client HTTP à utiliser pour tout appel authentifié -- le renouvellement transparent (critères
 * d'acceptation 2 et 3, L6-02) y est déjà branché. */
export const apiClient = withTransparentRefresh(baseHttpClient, authClient);
