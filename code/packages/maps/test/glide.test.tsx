// 14 novembre : la moto glisse d'une position à la suivante sur la carte Google native (les
// téléphones du serveur de développement) comme sur Leaflet (test/osmGlide.test.ts).
jest.mock('react-native-maps');

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Marker, __camera } from 'react-native-maps';
import { GoogleMapView } from '../src/providers/google/MapView';
import { GLIDE_MAX_MS, GLIDE_MIN_MS, glideDurationMs, glidePosition } from '../src/glide';
import type { MapViewProps } from '../src/types';

const A = { latitude: 4.05, longitude: 9.7 };
const B = { latitude: 4.051, longitude: 9.701 };

describe('glide.ts', () => {
  test('durée = temps écoulé depuis la position précédente, bornée', () => {
    expect(glideDurationMs(A, B, 0, 3_000)).toBe(3_000);
    expect(glideDurationMs(A, B, 0, 50)).toBe(GLIDE_MIN_MS);
    expect(glideDurationMs(A, B, 0, 60_000)).toBe(GLIDE_MAX_MS);
  });

  test('première position, ou plus de ~500 m : saut', () => {
    expect(glideDurationMs(A, B, null, 3_000)).toBe(0);
    expect(glideDurationMs(A, { latitude: 4.07, longitude: 9.7 }, 0, 3_000)).toBe(0);
  });

  test('interpolation linéaire, jamais au-delà de la cible', () => {
    const halfway = glidePosition(A, B, 0, 3_000, 1_500);
    expect(halfway.latitude).toBeCloseTo(4.0505, 9);
    expect(halfway.longitude).toBeCloseTo(9.7005, 9);
    expect(glidePosition(A, B, 0, 3_000, 9_000)).toEqual(B);
  });
});

describe('carte Google native', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __camera.animateCamera.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  function render(props: MapViewProps) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<GoogleMapView {...props} />);
    });
    return {
      update: (next: MapViewProps) =>
        ReactTestRenderer.act(() => {
          renderer.update(<GoogleMapView {...next} />);
        }),
      coordinateOf: (id: string) => renderer.root.findAllByType(Marker).find((m) => m.props.identifier === id)!.props.coordinate,
      advance: (ms: number) =>
        ReactTestRenderer.act(() => {
          jest.advanceTimersByTime(ms);
        }),
      unmount: () => ReactTestRenderer.act(() => renderer.unmount()),
    };
  }

  test('la moto glisse vers sa nouvelle position ; une épingle, elle, ne bouge pas en glissant', () => {
    const pin = { id: 'pickup', kind: 'pickup' as const, position: A };
    const map = render({ center: A, markers: [{ id: 'driver', kind: 'driver', position: A }, pin] });
    map.advance(3_000);
    map.update({ center: A, markers: [{ id: 'driver', kind: 'driver', position: B }, { ...pin, position: B }] });

    expect(map.coordinateOf('pickup')).toEqual(B);
    map.advance(1_500);
    const halfway = map.coordinateOf('driver');
    expect(halfway.latitude).toBeCloseTo(4.0505, 4);
    expect(halfway.longitude).toBeCloseTo(9.7005, 4);
    map.advance(1_600);
    expect(map.coordinateOf('driver')).toEqual(B);
    map.unmount();
  });

  test('la caméra qui suit la moto glisse sur la même durée', () => {
    const map = render({ center: A, markers: [] });
    map.advance(3_000);
    map.update({ center: B, markers: [] });
    map.advance(3_000);
    map.update({ center: { latitude: 4.052, longitude: 9.702 }, markers: [] });
    const calls = __camera.animateCamera.mock.calls;
    expect(calls[calls.length - 1]![1]).toEqual({ duration: 3_000 });
    map.unmount();
  });
});
