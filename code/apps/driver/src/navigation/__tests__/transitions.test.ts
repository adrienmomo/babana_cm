import { asRideId } from '@babana/navigation';
import { replaceWithSettlement, replaceWithHome } from '../transitions';

describe('transitions (piège du bouton retour Android, spécification L6-00)', () => {
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
