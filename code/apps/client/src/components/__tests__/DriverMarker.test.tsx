import React from 'react';
import { Image, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';
import { DriverMarker } from '../DriverMarker';

function driver(overrides: Partial<http.NearbyDriver> = {}): http.NearbyDriver {
  return {
    driverId: 'driver-1',
    firstName: 'Paul',
    photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
    rating: 4.8,
    motorcycleClass: 'standard',
    position: { latitude: 4.05, longitude: 9.7 },
    distanceMeters: 350,
    ...overrides,
  };
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function renderDriver(driverProps: http.NearbyDriver): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<DriverMarker driver={driverProps} />);
  });
  return root;
}

describe('DriverMarker (L6-06, D30)', () => {
  it('affiche prénom, note et gamme quand le profil est connu', async () => {
    const root = await renderDriver(driver());
    expect(texts(root)).toContain('Paul');
    expect(texts(root)).toContain('4.8');
    expect(texts(root)).toContain('Standard');
  });

  it('critère D30 : un profil manquant affiche un avatar générique et un libellé neutre, jamais une absence', async () => {
    const root = await renderDriver(driver({ firstName: null, photoUrl: null, rating: null, motorcycleClass: null }));
    expect(texts(root)).toContain('Chauffeur');
    expect(texts(root)).toContain('Nouveau');
    expect(root.root.findByType(Image).props.source.uri).toContain('driver-avatar-generic');
  });

  it('une note absente est marquée « nouveau », jamais une note à zéro (L4-09)', async () => {
    const root = await renderDriver(driver({ rating: null }));
    expect(texts(root)).toContain('Nouveau');
    expect(texts(root)).not.toContain('0.0');
  });

  it('critère 5 : une distance sous 1 km est arrondie au palier de 50 m, jamais au mètre près', async () => {
    const root = await renderDriver(driver({ distanceMeters: 372 }));
    expect(texts(root)).toContain('350 m');
    expect(texts(root)).not.toContain('372');
  });

  it('critère 5 : une distance au-delà de 1 km est affichée au dixième de km', async () => {
    const root = await renderDriver(driver({ distanceMeters: 2350 }));
    expect(texts(root)).toContain('2.4 km');
  });
});
