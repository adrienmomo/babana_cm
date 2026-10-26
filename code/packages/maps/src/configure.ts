import { configureGoogleMapsProvider } from './providers/google/config';
import { setMapTiles } from './providers/osm/config';
import { setRoutingUrl } from './routingConfig';

export interface MapsConfig {
  /** Clé Google pour la recherche de lieu et le géocodage inverse (appels REST). */
  apiKey: string;
  searchUrl?: string;
  /** Adresse des tuiles OpenStreetMap (`{r}` accepté : tuiles @2x sur écran dense). Absente : la
   * carte reste celle de Google. */
  tileUrl?: string;
  /** Crédit exigé par le fournisseur de tuiles -- requis dès que `tileUrl` est posée. */
  tileAttribution?: string;
  /** Service de routage au format OSRM (itinéraires, `fetchRoute`). Absent : pas d'itinéraire. */
  routingUrl?: string;
}

/**
 * Point de configuration unique du paquet (L6-00, critère 7). Importe seulement des modules de
 * configuration sans SDK -- jamais le barrel d'un fournisseur (voir `index.ts`, L6-18).
 */
export function configureMapsProvider(config: MapsConfig): void {
  configureGoogleMapsProvider({ apiKey: config.apiKey, searchUrl: config.searchUrl });
  setMapTiles(config.tileUrl, config.tileAttribution);
  setRoutingUrl(config.routingUrl);
}
