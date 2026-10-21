import type { NavigationContainerRef } from '@react-navigation/native';
import type { DriverParamList } from './types';

/**
 * Fin de course (L6-13) : la carte de `Home` -> `Settlement`, pile remplacée -- un retour ne doit pas
 * rouvrir une course déjà terminée pour la « re-terminer ».
 */
export function replaceWithSettlement(
  navigation: Pick<NavigationContainerRef<DriverParamList>, 'reset'>,
  params: DriverParamList['Settlement']
): void {
  navigation.reset({ index: 0, routes: [{ name: 'Settlement', params }] });
}

/**
 * Fin de course, après encaissement (L6-14) : retour à l'écran permanent, pile remplacée --
 * un retour ne doit pas rouvrir une course déjà encaissée.
 */
export function replaceWithHome(navigation: Pick<NavigationContainerRef<DriverParamList>, 'reset'>): void {
  navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
}
