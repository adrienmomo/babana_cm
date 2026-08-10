import type { http } from '@babana/contracts';

/**
 * Abstraction carte et navigation (C3, `01-architecture.md` §4). Aucun écran de `apps/*`
 * n'importe un SDK de carte directement, seulement cette interface -- règle vérifiée
 * mécaniquement par le lint (`.eslintrc.cjs`, `no-restricted-imports`). En v1, l'implémentation
 * de `openNavigation` est un lien profond vers Google Maps (D12) ; en v2, elle devient le
 * Navigation SDK sans qu'aucun écran ne change.
 *
 * Export minimal fonctionnel ce soir (L0-03, critère : « importable par les deux apps
 * immédiatement »). L'implémentation réelle (fournisseur Google Maps, D13) arrive avec L6-01.
 */

export type LatLng = http.LatLng;

export interface PlaceResult {
  name: string;
  position: LatLng;
}

export interface MapProvider {
  /** Trace un tracé sur la carte actuellement affichée. */
  drawRoute(points: LatLng[]): void;
  /** Ouvre un guidage vers un point -- lien profond en v1 (D12), Navigation SDK en v2. */
  openNavigation(destination: LatLng): void;
  /** Recherche un lieu ; l'adresse formelle n'existe quasiment pas à Douala (repères). */
  searchPlace(query: string): Promise<PlaceResult[]>;
}

/**
 * Implémentation par défaut avant L6-01 : échoue de façon explicite plutôt que de rendre une
 * carte vide silencieusement, pour qu'un écran qui l'utiliserait par erreur cette nuit le
 * découvre immédiatement plutôt qu'en recette.
 */
class NotYetImplementedMapProvider implements MapProvider {
  private fail(method: string): never {
    throw new Error(`@babana/maps: ${method}() sera implémenté par L6-01 (fournisseur Google Maps, D13).`);
  }

  drawRoute(): void {
    this.fail('drawRoute');
  }

  openNavigation(): void {
    this.fail('openNavigation');
  }

  async searchPlace(): Promise<PlaceResult[]> {
    this.fail('searchPlace');
  }
}

export const mapProvider: MapProvider = new NotYetImplementedMapProvider();
