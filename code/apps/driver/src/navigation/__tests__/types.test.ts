import { asRideId } from '@babana/navigation';
import type { DriverParamList } from '../types';

/**
 * Preuve de compilation (critère d'acceptation 2 de L6-00) -- même raisonnement que
 * apps/client/src/navigation/__tests__/types.test.ts.
 */
const rideId = asRideId('r1');

const valid: DriverParamList['ActiveRide'] = {
  rideId,
  origin: { latitude: 4.05, longitude: 9.7 },
  destination: { latitude: 4.061, longitude: 9.71 },
  amount: 1500,
  distanceMeters: 3200,
};

// @ts-expect-error -- un identifiant numérique n'est pas un RideId : doit casser la compilation.
const wrongType: DriverParamList['ActiveRide'] = { ...valid, rideId: 42 };

// @ts-expect-error -- Home ne prend aucun paramètre.
const extraParam: DriverParamList['Home'] = { rideId };

it('un paramètre de route mal typé casse tsc --noEmit (voir les @ts-expect-error ci-dessus)', () => {
  expect(valid.rideId).toBe(rideId);
  expect(wrongType).toBeDefined();
  expect(extraParam).toBeDefined();
});
