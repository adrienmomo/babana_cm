import { configureGoogleMapsProvider } from './providers/google/config';
import { setMapTileUrl } from './providers/osm/config';

export interface MapsConfig {
  /** Clé Google pour la recherche de lieu et le géocodage inverse (appels REST). */
  apiKey: string;
  searchUrl?: string;
  /** Adresse des tuiles OpenStreetMap. Absente : la carte reste celle de Google. */
  tileUrl?: string;
}

/**
 * Point de configuration unique du paquet (L6-00, critère 7). Importe seulement des modules de
 * configuration sans SDK -- jamais le barrel d'un fournisseur (voir `index.ts`, L6-18).
 */
export function configureMapsProvider(config: MapsConfig): void {
  configureGoogleMapsProvider({ apiKey: config.apiKey, searchUrl: config.searchUrl });
  setMapTileUrl(config.tileUrl);
}
