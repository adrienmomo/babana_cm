import type { MapProvider } from '../../types';
import { WebMapView } from './MapView';
import { openNavigation } from './navigation';
import { reverseGeocode, searchPlace } from '../google/places';

/**
 * `searchPlace`/`reverseGeocode` sont réutilisés tels quels depuis `providers/google/places.ts`
 * (jamais réimplémentés) : ces deux appels ne sont que du REST (`fetch`, `URL`), sans aucun
 * import du SDK natif -- importés directement (pas via `providers/google/index.ts`, le barrel du
 * fournisseur natif, qui tire `react-native-maps` dès son évaluation).
 */
export const webMapProvider: MapProvider = {
  MapView: WebMapView,
  openNavigation,
  searchPlace,
  reverseGeocode,
};
