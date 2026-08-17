import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { reportMetric } from '../metrics';

/**
 * Obtention de l'ID token par Google Sign-In natif (L6-02, D22 -- premier des deux chemins,
 * l'autre étant le flux OAuth web de l'export Client, L6-18, hors de ce lot). Tout ce fichier
 * fait est produire un `idToken` ; l'échange contre le jeton applicatif (`AuthClient.
 * signInWithGoogle`, `session.ts`) est strictement le même quel que soit le chemin qui l'a
 * obtenu (critère d'acceptation 6) -- ne rien dupliquer ici de la logique d'échange.
 *
 * **Empreinte de signature (console Google, pas du code).** L'identifiant client OAuth Android
 * est lié à l'empreinte SHA-1 du certificat de signature -- il en faut un pour le certificat de
 * développement (`debug.keystore`) et un second pour celui de publication. Oublier le second
 * produit une connexion qui fonctionne en développement et échoue en production. Concrètement,
 * dans Google Cloud Console (identifiants OAuth 2.0) :
 * 1. Un identifiant client **Web** (`webClientId`, passé à `configureGoogleSignIn`) -- c'est lui
 *    que Google appose comme `aud` dans l'ID token, et c'est cet `aud` que le backend vérifie
 *    (`GOOGLE_OAUTH_CLIENT_IDS`, `services/odoo`) : sans un `webClientId` correctement configuré,
 *    aucun ID token exploitable n'est produit, même si la connexion native réussit visuellement.
 * 2. Un identifiant client **Android** par empreinte de certificat (nom de package +
 *    SHA-1 debug, puis nom de package + SHA-1 release) -- c'est lui qui autorise l'app à déclencher
 *    le flux natif ; il n'est jamais passé en configuration ici, Google le retrouve depuis le
 *    package/l'empreinte au moment de l'appel.
 * 3. (iOS) Un identifiant client **iOS** (`iosClientId`), et l'URL scheme correspondant déclaré
 *    dans `Info.plist`.
 */
export interface GoogleSignInConfig {
  webClientId: string;
  iosClientId?: string;
}

let configured = false;

export function configureGoogleSignIn(config: GoogleSignInConfig): void {
  GoogleSignin.configure({
    webClientId: config.webClientId,
    iosClientId: config.iosClientId,
    offlineAccess: false,
  });
  configured = true;
}

/** Réservé aux tests. */
export function _resetGoogleSignInConfigForTests(): void {
  configured = false;
}

export class GooglePlayServicesUnavailableError extends Error {
  constructor() {
    super("Google Play Services n'est pas disponible sur cet appareil -- la connexion Google est impossible ici.");
    this.name = 'GooglePlayServicesUnavailableError';
  }
}

export class GoogleSignInCancelledError extends Error {
  constructor() {
    super('Connexion Google annulée.');
    this.name = 'GoogleSignInCancelledError';
  }
}

/**
 * Résout un ID token Google, prêt à échanger contre un jeton applicatif. Gère explicitement
 * l'absence de Google Play Services (critère d'acceptation 4, risque identifié É1) : message
 * clair via un type d'erreur dédié plutôt qu'un code brut, et une métrique -- c'est cette mesure
 * qui dira s'il faut rouvrir D4 (choix d'Android).
 */
export async function signInWithGoogleNative(): Promise<string> {
  if (!configured) {
    throw new Error(
      '@babana/api-client: configureGoogleSignIn({ webClientId, iosClientId? }) doit être ' +
        'appelé au démarrage de l\'app avant signInWithGoogleNative().'
    );
  }

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (error) {
    if (isErrorWithCode(error) && error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      reportMetric('auth.google_play_services_unavailable');
      throw new GooglePlayServicesUnavailableError();
    }
    throw error;
  }

  let response;
  try {
    response = await GoogleSignin.signIn();
  } catch (error) {
    if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new GoogleSignInCancelledError();
    }
    throw error;
  }

  if (!isSuccessResponse(response) || !response.data.idToken) {
    throw new GoogleSignInCancelledError();
  }

  return response.data.idToken;
}
