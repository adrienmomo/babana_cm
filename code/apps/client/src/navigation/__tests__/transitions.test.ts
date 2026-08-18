import { asDriverId, asRideId } from '@babana/navigation';
import { replaceWithRideFlow } from '../transitions';
import type { ClientParamList } from '../types';

describe('replaceWithRideFlow (piège du bouton retour Android, spécification L6-00)', () => {
  it("remplace la pile plutôt que d'empiler -- Waiting devient seul, à l'index 0", () => {
    const reset = jest.fn();
    const rideId = asRideId('r1');
    const params: ClientParamList['Waiting'] = {
      rideId,
      driverId: asDriverId('d1'),
      proposalExpiresAt: '2026-08-18T07:00:30+01:00',
      amount: 1200,
      selectedAt: Date.now(),
      selection: {
        origin: { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' },
        destination: { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' },
        nearbyDrivers: [],
        excludedDriverIds: [],
        rejectionStreak: 0,
      },
    };

    replaceWithRideFlow({ reset }, params);

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Waiting', params }] });
    // Un seul élément dans routes : un retour depuis Waiting ne peut pas atteindre Quote, qui
    // n'est plus dans la pile du tout.
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });
});
