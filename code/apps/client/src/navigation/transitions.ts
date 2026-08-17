import type { NavigationContainerRef } from '@react-navigation/native';
import type { ClientParamList } from './types';

/**
 * Le piège du bouton retour Android (L6-00, spécification) : un retour depuis le suivi de
 * course ne doit pas ramener à l'écran d'estimation d'une course déjà commandée. `reset()`,
 * jamais `navigate()`/`push()`, au moment où la course existe côté serveur -- la pile
 * Home/Quote est remplacée, pas empilée sous Waiting. Appelé par L6-08 dès que
 * `POST /rides` (L4-03) a répondu.
 *
 * À l'intérieur de la phase course (Waiting -> DriverRejected -> Tracking -> RideSummary), la
 * même technique s'applique où le retour vers un état déjà dépassé n'aurait pas de sens (par
 * exemple Tracking -> RideSummary, une fois la course terminée) -- laissé à L6-08/L6-09, qui
 * connaissent le déroulé réel de ces écrans.
 */
export function replaceWithRideFlow(
  navigation: Pick<NavigationContainerRef<ClientParamList>, 'reset'>,
  params: ClientParamList['Waiting']
): void {
  navigation.reset({ index: 0, routes: [{ name: 'Waiting', params }] });
}
