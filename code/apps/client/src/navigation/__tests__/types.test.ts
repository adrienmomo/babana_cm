import { asRideId } from '@babana/navigation';
import type { ClientParamList } from '../types';

/**
 * Preuve de compilation (critère d'acceptation 2 de L6-00) : les `@ts-expect-error` ci-dessous
 * ne s'exécutent pas, ils font échouer `npm run typecheck` si le type redevient permissif --
 * même famille que `packages/maps/test/emptyProvider.test.ts` ("l'assignation EST la preuve").
 * Le test à l'exécution ci-dessous n'existe que pour que Jest ne se plaigne pas d'une suite
 * vide ; la preuve réelle est dans `tsc --noEmit`, pas dans cette assertion.
 */
const rideId = asRideId('r1');

const valid: ClientParamList['Tracking'] = { rideId };

// @ts-expect-error -- un identifiant numérique n'est pas un RideId : doit casser la compilation.
const wrongType: ClientParamList['Tracking'] = { rideId: 42 };

// @ts-expect-error -- Home ne prend aucun paramètre.
const extraParam: ClientParamList['Home'] = { rideId };

it('un paramètre de route mal typé casse tsc --noEmit (voir les @ts-expect-error ci-dessus)', () => {
  expect(valid.rideId).toBe(rideId);
  expect(wrongType).toBeDefined();
  expect(extraParam).toBeDefined();
});
