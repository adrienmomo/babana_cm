/**
 * Second chemin d'authentification (L6-18, D22) : flux OAuth web par Google Identity Services
 * (GIS), résolu à la place de `googleSignIn.ts` (natif) par l'extension `.web.ts` -- même
 * mécanisme que `tokenStorage.web.ts`, jamais un `Platform.OS` lu à l'exécution. Mêmes exports
 * que le fichier natif, mêmes noms (`configureGoogleSignIn`, `signInWithGoogleNative`...) : c'est
 * ce qui permet à `index.ts` de les réexporter sans savoir lequel des deux fichiers a été
 * résolu, et à `SignInScreen.tsx` de ne jamais changer (critère d'acceptation 2).
 *
 * **Pas `@react-native-google-signin/google-signin` sur ce chemin.** Son propre `lib/module/
 * signIn/GoogleSignin.web.js` (vérifié dans node_modules avant d'écrire ce fichier) ne fait rien
 * d'autre que lever "Web support is only available to sponsors" -- webpack.config.js
 * anticipait cette librairie pour le web, à tort ; ce fichier n'en importe donc rien, et
 * `apps/client`'s webpack build ne charge plus ce paquet pour le bundle web (voir
 * `webpack.config.js`, la règle `javascript/auto` visant ses builds ESM ne s'y applique plus).
 *
 * **L'échange contre le jeton applicatif reste ailleurs** (L1-01, `AuthClient.
 * exchangeGoogleIdToken`, `session.ts`) : ce fichier ne produit qu'un `idToken`, exactement comme
 * `googleSignIn.ts`.
 */

export interface GoogleSignInConfig {
  webClientId: string;
  iosClientId?: string;
}

let webClientId: string | undefined;
let gsiLoadPromise: Promise<void> | undefined;

export function configureGoogleSignIn(config: GoogleSignInConfig): void {
  webClientId = config.webClientId;
}

/** Réservé aux tests. */
export function _resetGoogleSignInConfigForTests(): void {
  webClientId = undefined;
  gsiLoadPromise = undefined;
}

/**
 * Jamais levée sur le web -- il n'y a pas de Google Play Services dans un navigateur. La classe
 * existe malgré tout : `SignInScreen.tsx` (inchangé, critère d'acceptation 2) fait
 * `cause instanceof GooglePlayServicesUnavailableError`, et cette branche doit rester valide,
 * simplement jamais empruntée ici.
 */
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

const GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/** Charge le script GIS une seule fois par onglet, quel que soit le nombre de tentatives de
 * connexion -- un second appel réutilise la même promesse (ou constate que `window.google` est
 * déjà là, chargé par une tentative précédente). */
function loadGsiScript(): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(
      new Error("@babana/api-client: signInWithGoogleNative() (web) appelé hors d'un navigateur.")
    );
  }
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiLoadPromise) {
    gsiLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Un prochain appel doit pouvoir réessayer -- un script qui a échoué à charger une fois
        // (réseau coupé, blocage) ne doit pas condamner toute tentative future de la session.
        gsiLoadPromise = undefined;
        reject(new Error('@babana/api-client: chargement du script Google Identity Services échoué.'));
      };
      document.head.appendChild(script);
    });
  }
  return gsiLoadPromise;
}

/**
 * Un recouvrement plein écran hébergeant le vrai bouton Google (rendu par `renderButton`, pas
 * un bouton maison) -- GIS ne fournit pas de mode "popup déclenché par programme" fiable pour
 * l'ID token (le One Tap silencieux se heurte souvent aux cookies tiers désactivés) ; rendre le
 * vrai bouton et laisser l'utilisateur cliquer dessus est le chemin documenté par Google qui
 * marche partout. Ce recouvrement vit entièrement dans ce paquet, jamais dans un écran (critère
 * d'acceptation 2) : `SignInScreen.tsx` ne sait pas qu'il existe.
 */
function createOverlay(): { container: HTMLDivElement; buttonHost: HTMLDivElement; dismiss: HTMLButtonElement } {
  const container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(15, 23, 42, 0.55)',
    zIndex: '2147483647',
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    background: '#ffffff',
    padding: '24px',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px',
  });

  const buttonHost = document.createElement('div');

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Annuler';
  Object.assign(dismiss.style, {
    border: 'none',
    background: 'transparent',
    color: '#6B7280',
    cursor: 'pointer',
    font: 'inherit',
  });

  panel.appendChild(buttonHost);
  panel.appendChild(dismiss);
  container.appendChild(panel);

  return { container, buttonHost, dismiss };
}

/**
 * Résout un ID token Google par le flux web GIS. Signature identique à la version native
 * (critère d'acceptation 6, L6-02) : seule l'obtention diffère, l'échange (`session.ts`) est
 * strictement le même appelant.
 */
export async function signInWithGoogleNative(): Promise<string> {
  if (!webClientId) {
    throw new Error(
      "@babana/api-client: configureGoogleSignIn({ webClientId }) doit être appelé au démarrage " +
        "de l'app avant signInWithGoogleNative()."
    );
  }

  await loadGsiScript();
  const accounts = window.google?.accounts;
  if (!accounts) {
    throw new Error('@babana/api-client: Google Identity Services indisponible après chargement.');
  }

  return new Promise<string>((resolve, reject) => {
    const { container, buttonHost, dismiss } = createOverlay();
    let settled = false;

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      container.remove();
      action();
    }

    dismiss.onclick = () => settle(() => reject(new GoogleSignInCancelledError()));

    accounts.id.initialize({
      client_id: webClientId as string,
      cancel_on_tap_outside: false,
      callback: (response) => {
        if (response.credential) {
          settle(() => resolve(response.credential as string));
        } else {
          settle(() => reject(new GoogleSignInCancelledError()));
        }
      },
    });

    document.body.appendChild(container);
    accounts.id.renderButton(buttonHost, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
    });
  });
}
