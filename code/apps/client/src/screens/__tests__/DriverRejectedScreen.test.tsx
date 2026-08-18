import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asDriverId, asRideId } from '@babana/navigation';
import { DriverRejectedScreen } from '../DriverRejectedScreen';

const RIDE_ID = asRideId('ride-1');
const DRIVER_ID = asDriverId('driver-1');

function selection(overrides: Partial<{ excludedDriverIds: string[]; rejectionStreak: number }> = {}) {
  return {
    origin: { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' },
    destination: { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' },
    nearbyDrivers: [],
    excludedDriverIds: [],
    rejectionStreak: 0,
    rideId: RIDE_ID,
    ...overrides,
  };
}

function fakeNavigation() {
  return { navigate: jest.fn(), replace: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderRejected(
  params: { reason?: 'driver_rejected' | 'driver_timeout'; selection?: ReturnType<typeof selection> } = {},
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'DriverRejected',
    name: 'DriverRejected' as const,
    params: {
      rideId: RIDE_ID,
      driverId: DRIVER_ID,
      reason: params.reason ?? 'driver_rejected',
      selection: params.selection ?? selection(),
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<DriverRejectedScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

describe('DriverRejectedScreen (L6-08, D11)', () => {
  it('critère 1 : ramène automatiquement à la sélection, sans confirmation à cliquer', async () => {
    jest.useFakeTimers();
    const { navigation } = await renderRejected();

    expect(navigation.replace).not.toHaveBeenCalled();

    await act(async () => {
      jest.runAllTimers();
    });

    expect(navigation.replace).toHaveBeenCalledWith('Quote', expect.objectContaining({ rejectionStreak: 1 }));
  });

  it('critère 2 : le chauffeur qui vient de refuser est ajouté aux exclus de la liste réaffichée', async () => {
    jest.useFakeTimers();
    const { navigation } = await renderRejected({ selection: selection({ excludedDriverIds: ['already-excluded'] }) });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(navigation.replace).toHaveBeenCalledWith(
      'Quote',
      expect.objectContaining({ excludedDriverIds: ['already-excluded', DRIVER_ID] })
    );
  });

  it('critère 3 : le message distingue un refus explicite d’une expiration', async () => {
    const rejected = await renderRejected({ reason: 'driver_rejected' });
    const timeout = await renderRejected({ reason: 'driver_timeout' });

    const rejectedMessage = rejected.root.root.findByProps({ testID: 'driver-rejected-message' }).props.children;
    const timeoutMessage = timeout.root.root.findByProps({ testID: 'driver-rejected-message' }).props.children;

    expect(rejectedMessage).not.toEqual(timeoutMessage);
    expect(rejectedMessage).toMatch(/disponible|prendre/);
    expect(timeoutMessage).toMatch(/répondu|réponse|injoignable/);
  });

  it('critère 3 : le message varie après plusieurs refus consécutifs, jamais identique en boucle', async () => {
    const first = await renderRejected({ selection: selection({ rejectionStreak: 0 }) });
    const second = await renderRejected({ selection: selection({ rejectionStreak: 1 }) });
    const third = await renderRejected({ selection: selection({ rejectionStreak: 5 }) });

    const messages = [first, second, third].map((r) => r.root.root.findByProps({ testID: 'driver-rejected-message' }).props.children);

    expect(new Set(messages).size).toBeGreaterThan(1);
  });
});
