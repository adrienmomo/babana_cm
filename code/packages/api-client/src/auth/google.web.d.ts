/**
 * Surface minimale de Google Identity Services (GIS) réellement utilisée par
 * `googleSignIn.web.ts` -- pas un paquet de types tiers (`@types/google.accounts`) : la surface
 * consommée ici tient en une poignée de méthodes, et une dépendance de types complète pour ça
 * serait le genre de poids que CLAUDE.md demande de signaler avant d'ajouter. Chargé par
 * tsconfig.web.json (motif "*.web.d.ts" sous src/) uniquement -- jamais vu par la compilation
 * native.
 */
interface GoogleIdCredentialResponse {
  credential?: string;
}

interface GoogleIdInitializeConfig {
  client_id: string;
  callback: (response: GoogleIdCredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
}

interface GoogleIdButtonOptions {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
}

interface GoogleAccountsId {
  initialize(config: GoogleIdInitializeConfig): void;
  renderButton(parent: HTMLElement, options?: GoogleIdButtonOptions): void;
  disableAutoSelect(): void;
}

interface Window {
  google?: {
    accounts: {
      id: GoogleAccountsId;
    };
  };
}
