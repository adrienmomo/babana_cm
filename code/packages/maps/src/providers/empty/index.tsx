import type { MapProvider, MapViewProps } from '../../types';

/**
 * Second fournisseur, vide, dont le seul but est de compiler contre `MapProvider` sans jamais
 * importer un SDK de carte (L6-01, critère d'acceptation 5 -- "le vrai test" de l'abstraction :
 * une interface qui n'accueille qu'une seule implémentation n'en est pas une). N'est branché
 * nulle part comme fournisseur actif ; sert de preuve de compilation et, dans les tests, de
 * fournisseur simulé qui échoue explicitement plutôt que de rendre une carte vide en silence.
 */
function notImplemented(method: string): never {
  throw new Error(
    `@babana/maps: fournisseur vide -- ${method}() n'a pas d'implémentation (providers/empty, ` +
      'preuve de compilation contre MapProvider, L6-01 critère 5).'
  );
}

function EmptyMapView(_props: MapViewProps): null {
  notImplemented('MapView');
}

export const emptyMapProvider: MapProvider = {
  MapView: EmptyMapView,
  openNavigation() {
    notImplemented('openNavigation');
  },
  async searchPlace() {
    notImplemented('searchPlace');
  },
  async reverseGeocode() {
    notImplemented('reverseGeocode');
  },
};
