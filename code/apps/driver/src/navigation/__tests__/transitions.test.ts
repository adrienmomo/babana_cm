import { asRideId } from '@babana/navigation';
import { replaceWithActiveRide, replaceWithHome } from '../transitions';

describe('transitions (piège du bouton retour Android, spécification L6-00)', () => {
  it('replaceWithActiveRide remplace la pile -- un retour ne peut pas rouvrir Proposal', () => {
    const reset = jest.fn();
    const rideId = asRideId('r1');

    replaceWithActiveRide({ reset }, { rideId });

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'ActiveRide', params: { rideId } }] });
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });

  it('replaceWithHome remplace la pile -- un retour ne peut pas rouvrir une course encaissée', () => {
    const reset = jest.fn();

    replaceWithHome({ reset });

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Home' }] });
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });
});
