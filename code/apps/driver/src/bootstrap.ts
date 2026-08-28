import { configureGoogleSignIn } from '@babana/api-client';
import { configureMapsProvider } from '@babana/maps';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_MAPS_API_KEY, GOOGLE_WEB_CLIENT_ID } from '../config';
import { configureProposalAlerts } from './proposalAlert';
import { locationTracker } from './location';

/**
 * Point d'accroche unique et nommé pour toute configuration à effectuer une seule fois, au tout
 * début du démarrage de l'app (L6-00, critère d'acceptation 7). Même rôle que
 * apps/client/src/bootstrap.ts -- voir ce fichier pour le détail du raisonnement.
 */
let bootstrapped = false;

export function bootstrap(): void {
  if (bootstrapped) return;
  configureGoogleSignIn({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
  configureMapsProvider({ apiKey: GOOGLE_MAPS_API_KEY });
  configureProposalAlerts();
  locationTracker.start();
  bootstrapped = true;
}
