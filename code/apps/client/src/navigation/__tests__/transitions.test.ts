import { asRideId } from '@babana/navigation';
import { replaceWithRideFlow } from '../transitions';

describe('replaceWithRideFlow (piège du bouton retour Android, spécification L6-00)', () => {
  it("remplace la pile plutôt que d'empiler -- Waiting devient seul, à l'index 0", () => {
    const reset = jest.fn();
    const rideId = asRideId('r1');

    replaceWithRideFlow({ reset }, { rideId });

    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Waiting', params: { rideId } }] });
    // Un seul élément dans routes : un retour depuis Waiting ne peut pas atteindre Quote, qui
    // n'est plus dans la pile du tout.
    expect(reset.mock.calls[0][0].routes).toHaveLength(1);
  });
});
