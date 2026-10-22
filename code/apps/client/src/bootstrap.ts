import { configureMapsProvider } from '@babana/maps';
import { GOOGLE_MAPS_API_KEY, MAP_TILE_URL, MAPS_SEARCH_URL } from '../config';

/**
 * Point d'accroche unique et nommé pour toute configuration à effectuer une seule fois, au tout
 * début du démarrage de l'app (L6-00, critère d'acceptation 7). Appelé explicitement
 * depuis `App.tsx` avant que la navigation ne monte : la liste de ce que l'app configure au
 * démarrage se lit ici plutôt que de se déduire de l'ordre des imports.
 */
let bootstrapped = false;

export function bootstrap(): void {
  if (bootstrapped) return;
  configureMapsProvider({ apiKey: GOOGLE_MAPS_API_KEY, searchUrl: MAPS_SEARCH_URL, tileUrl: MAP_TILE_URL });
  bootstrapped = true;
}
