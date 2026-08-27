import type { NavigationContainerRef } from '@react-navigation/native';
import type { DriverParamList } from './types';

/**
 * Acceptation d'une proposition (L6-12) : `reset()`, pas `navigate()` -- un retour depuis la
 * course en cours ne doit pas ramener à une proposition déjà acceptée (même piège que côté
 * Client, spécification L6-00). La pile Home/Proposal est remplacée par ActiveRide seul.
 */
export function replaceWithActiveRide(
  navigation: Pick<NavigationContainerRef<DriverParamList>, 'reset'>,
  params: DriverParamList['ActiveRide']
): void {
  navigation.reset({ index: 0, routes: [{ name: 'ActiveRide', params }] });
}

/**
 * Fin de course (L6-13) : `ActiveRide` -> `Settlement`, pile remplacée -- un retour ne doit pas
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
