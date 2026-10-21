import { configureMapsProvider } from '@babana/maps';
import { GOOGLE_MAPS_API_KEY, MAP_TILE_URL } from '../config';
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
  configureMapsProvider({ apiKey: GOOGLE_MAPS_API_KEY, tileUrl: MAP_TILE_URL });
  configureProposalAlerts();
  locationTracker.start();
  bootstrapped = true;
}
