import { configureGoogleSignIn } from '@babana/api-client';
import { configureMapsProvider } from '@babana/maps';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_MAPS_API_KEY, GOOGLE_WEB_CLIENT_ID } from '../config';

/**
 * Point d'accroche unique et nommé pour toute configuration à effectuer une seule fois, au tout
 * début du démarrage de l'app (L6-00, critère d'acceptation 7). Avant cette tâche,
 * `configureGoogleSignIn` était appelé comme effet de bord au chargement de `src/auth.ts` (L6-02)
 * -- correct, mais implicite, et `configureMapsProvider` (L6-01) n'était appelé nulle part.
 * Regrouper les deux ici, appelé explicitement depuis `App.tsx` avant que la navigation ne monte,
 * rend visible la liste complète de ce que l'app configure au démarrage plutôt que de la laisser
 * se déduire de l'ordre des imports.
 */
let bootstrapped = false;

export function bootstrap(): void {
  if (bootstrapped) return;
  configureGoogleSignIn({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
  configureMapsProvider({ apiKey: GOOGLE_MAPS_API_KEY });
  bootstrapped = true;
}
