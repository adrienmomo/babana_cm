const mockOpenNavigation = jest.fn();
jest.mock('@babana/maps', () => ({
  openNavigation: (...args: unknown[]) => mockOpenNavigation(...args),
}));

import { launchRideNavigation } from '../launch';

const ORIGIN = { latitude: 4.05, longitude: 9.7 };
const DESTINATION = { latitude: 4.061, longitude: 9.71 };

beforeEach(() => jest.clearAllMocks());

describe('launchRideNavigation (L6-13)', () => {
  it('phase approche -- guide vers le point de prise en charge', () => {
    const onReturn = jest.fn();
    launchRideNavigation('approach', { origin: ORIGIN, destination: DESTINATION }, onReturn);

    expect(mockOpenNavigation).toHaveBeenCalledWith(ORIGIN, { label: 'Point de prise en charge', onComplete: onReturn });
  });

  it('phase trajet -- guide vers la destination', () => {
    launchRideNavigation('transit', { origin: ORIGIN, destination: DESTINATION });

    expect(mockOpenNavigation).toHaveBeenCalledWith(DESTINATION, { label: 'Destination de la course', onComplete: undefined });
  });

  it('passe toujours par @babana/maps -- jamais un SDK de carte en direct', () => {
    launchRideNavigation('approach', { origin: ORIGIN, destination: DESTINATION });
    expect(mockOpenNavigation).toHaveBeenCalledTimes(1);
  });
});
