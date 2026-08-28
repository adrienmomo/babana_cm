import { asRideId } from '@babana/navigation';
import { replaceWithActiveRide, replaceWithSettlement, replaceWithHome } from '../transitions';

const ACTIVE_RIDE_PARAMS = {
  rideId: asRideId('r1'),
  origin: { latitude: 4.05, longitude: 9.7 },
  destination: { latitude: 4.061, longitude: 9.71 },
  amount: 1500,
  distanceMeters: 3200,
  clientPhoneNumber: '+237691234567',
};

describe('transitions (piège du bouton retour Android, spécification L6-00)', () => {
  it('replaceWithActiveRide remplace la pile -- un retour ne peut pas rouvrir Proposal', () => {
    const reset = jest.fn();

    replaceWithActiveRide({ reset }, ACTIVE_RIDE_PARAMS);

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'ActiveRide', params: ACTIVE_RIDE_PARAMS }] });
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });

  it('replaceWithSettlement remplace la pile -- un retour ne peut pas « re-terminer » une course', () => {
    const reset = jest.fn();

    replaceWithSettlement({ reset }, { rideId: asRideId('r1'), amount: 1500 });

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Settlement', params: { rideId: asRideId('r1'), amount: 1500 } }] });
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });

  it('replaceWithHome remplace la pile -- un retour ne peut pas rouvrir une course encaissée', () => {
    const reset = jest.fn();

    replaceWithHome({ reset });

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Home' }] });
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });
});
