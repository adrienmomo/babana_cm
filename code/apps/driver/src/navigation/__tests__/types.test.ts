import { asRideId } from '@babana/navigation';
import type { DriverParamList } from '../types';

/**
 * Preuve de compilation (critère d'acceptation 2 de L6-00) -- même raisonnement que
 * apps/client/src/navigation/__tests__/types.test.ts.
 */
const rideId = asRideId('r1');

const valid: DriverParamList['ActiveRide'] = { rideId };

// @ts-expect-error -- un identifiant numérique n'est pas un RideId : doit casser la compilation.
const wrongType: DriverParamList['ActiveRide'] = { rideId: 42 };

// @ts-expect-error -- Home ne prend aucun paramètre.
const extraParam: DriverParamList['Home'] = { rideId };

it('un paramètre de route mal typé casse tsc --noEmit (voir les @ts-expect-error ci-dessus)', () => {
  expect(valid.rideId).toBe(rideId);
  expect(wrongType).toBeDefined();
  expect(extraParam).toBeDefined();
});
