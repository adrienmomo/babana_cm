import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';
import { DriverCard } from '../DriverCard';

function driver(overrides: Partial<http.NearbyDriver> = {}): http.NearbyDriver {
  return {
    driverId: 'driver-1',
    firstName: 'Paul',
    photoUrl: null,
    rating: 4.8,
    motorcycleClass: 'standard',
    position: { latitude: 4.05, longitude: 9.7 },
    distanceMeters: 350,
    ...overrides,
  };
}

async function renderCard(props: Partial<React.ComponentProps<typeof DriverCard>> = {}): Promise<ReactTestRenderer> {
  const onSelect = props.onSelect ?? jest.fn();
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<DriverCard driver={props.driver ?? driver()} onSelect={onSelect} disabled={props.disabled} />);
  });
  return root;
}

describe('DriverCard (L6-07)', () => {
  it('toucher la carte sélectionne ce chauffeur', async () => {
    const onSelect = jest.fn();
    const root = await renderCard({ onSelect });

    await act(async () => {
      root.root.findByProps({ testID: 'driver-card-driver-1' }).props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('driver-1');
  });

  it('désactivée pendant qu\'une autre sélection est en cours (D11 : une seule course à la fois)', async () => {
    const root = await renderCard({ disabled: true });

    expect(root.root.findByProps({ testID: 'driver-card-driver-1' }).props.disabled).toBe(true);
  });
});
