import { activeMapProvider } from './activeProvider';
import type { LatLng, NavigationOptions } from './types';

/** Ouvre un guidage vers `destination` (L6-01, D12). Signature indépendante du fournisseur actif
 * -- v1 (lien profond) et v2 (SDK embarqué) l'implémentent toutes deux sans que cette signature
 * ne change (critère d'acceptation 3). */
export function openNavigation(destination: LatLng, options?: NavigationOptions): void {
  activeMapProvider.openNavigation(destination, options);
}
