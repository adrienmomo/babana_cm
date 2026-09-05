/**
 * WebMapView (fournisseur web, L6-18) -- testé sans jsdom ni SDK réel (critère d'acceptation 4,
 * L6-01), avec un double de `google.maps.{Map,Marker,Polyline}` qui enregistre ses appels. Le
 * conteneur DOM lui-même est fourni par `createNodeMock` (react-test-renderer) : sans cette
 * option, un ref vers un composant hôte résout toujours à `null` en test, ce qui empêcherait
 * d'exercer la branche réelle (plutôt que le simple "ne lève pas" du fournisseur natif,
 * `test/MapView.test.tsx`, qui n'a pas ce problème -- react-native-maps rend un composant, pas un
 * noeud DOM).
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { WebMapView } from '../src/providers/web/MapView';
import { _resetGoogleMapsApiKeyForTests, configureGoogleMapsProvider } from '../src/providers/google/config';

class FakeMap {
  options: { center: { lat: number; lng: number } };
  listeners: Record<string, () => void> = {};
  constructor(_container: unknown, options: { center: { lat: number; lng: number } }) {
    this.options = options;
  }
  addListener(event: string, handler: () => void) {
    this.listeners[event] = handler;
    return { remove: jest.fn() };
  }
  getCenter() {
    return { lat: () => this.options.center.lat, lng: () => this.options.center.lng };
  }
}

class FakeMarker {
  options: unknown;
  setMap = jest.fn();
  constructor(options: unknown) {
    this.options = options;
  }
}

class FakePolyline {
  options: unknown;
  setMap = jest.fn();
  constructor(options: unknown) {
    this.options = options;
  }
}

function installFakeGoogleMaps(): { mapInstances: FakeMap[]; markerInstances: FakeMarker[]; polylineInstances: FakePolyline[] } {
  const mapInstances: FakeMap[] = [];
  const markerInstances: FakeMarker[] = [];
  const polylineInstances: FakePolyline[] = [];

  (global as unknown as { document: unknown }).document = {};
  (global as unknown as { window: unknown }).window = global;
  (global as unknown as { google: unknown }).google = {
    maps: {
      Map: class extends FakeMap {
        constructor(container: unknown, options: { center: { lat: number; lng: number } }) {
          super(container, options);
          mapInstances.push(this);
        }
      },
      Marker: class extends FakeMarker {
        constructor(options: unknown) {
          super(options);
          markerInstances.push(this);
        }
      },
      Polyline: class extends FakePolyline {
        constructor(options: unknown) {
          super(options);
          polylineInstances.push(this);
        }
      },
    },
  };

  return { mapInstances, markerInstances, polylineInstances };
}

function uninstallFakeGoogleMaps(): void {
  delete (global as unknown as { document?: unknown }).document;
  delete (global as unknown as { window?: unknown }).window;
  delete (global as unknown as { google?: unknown }).google;
}

describe('WebMapView (fournisseur web, L6-18)', () => {
  afterEach(() => {
    _resetGoogleMapsApiKeyForTests();
    uninstallFakeGoogleMaps();
  });

  it('construit une carte centrée sur la position initiale, avec un marqueur par entrée', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-maps-key' });
    const { mapInstances, markerInstances } = installFakeGoogleMaps();

    let root!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      root = ReactTestRenderer.create(
        <WebMapView
          center={{ latitude: 4.05, longitude: 9.7 }}
          markers={[
            { id: 'driver-1', kind: 'driver', position: { latitude: 4.051, longitude: 9.701 } },
          ]}
        />,
        { createNodeMock: () => ({}) }
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mapInstances).toHaveLength(1);
    expect(mapInstances[0]?.options.center).toEqual({ lat: 4.05, lng: 9.7 });
    expect(markerInstances).toHaveLength(1);
    expect(markerInstances[0]?.options).toMatchObject({ position: { lat: 4.051, lng: 9.701 } });

    ReactTestRenderer.act(() => { root.unmount(); });
  });

  it('rend une polyligne quand un tracé est fourni, la retire quand il disparaît', async () => {
    configureGoogleMapsProvider({ apiKey: 'test-maps-key' });
    const { polylineInstances } = installFakeGoogleMaps();

    let root!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      root = ReactTestRenderer.create(
        <WebMapView
          center={{ latitude: 4.05, longitude: 9.7 }}
          route={{ points: [{ latitude: 4.05, longitude: 9.7 }, { latitude: 4.06, longitude: 9.71 }] }}
        />,
        { createNodeMock: () => ({}) }
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(polylineInstances).toHaveLength(1);
    const firstPolyline = polylineInstances[0];

    await ReactTestRenderer.act(async () => {
      root.update(<WebMapView center={{ latitude: 4.05, longitude: 9.7 }} />);
      await Promise.resolve();
    });

    expect(firstPolyline?.setMap).toHaveBeenCalledWith(null);

    ReactTestRenderer.act(() => { root.unmount(); });
  });

  it("ne recentre pas la carte quand `center` change après le montage (sémantique initialRegion)", async () => {
    configureGoogleMapsProvider({ apiKey: 'test-maps-key' });
    const { mapInstances } = installFakeGoogleMaps();

    let root!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      root = ReactTestRenderer.create(
        <WebMapView center={{ latitude: 4.05, longitude: 9.7 }} />,
        { createNodeMock: () => ({}) }
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await ReactTestRenderer.act(async () => {
      root.update(<WebMapView center={{ latitude: 5.0, longitude: 10.0 }} />);
      await Promise.resolve();
    });

    // Un seul appel à `new google.maps.Map(...)`, jamais un second à cause du changement de prop.
    expect(mapInstances).toHaveLength(1);

    ReactTestRenderer.act(() => { root.unmount(); });
  });

  it("ne lève pas si la carte ne peut pas se charger (dégradation, pas d'écran d'erreur dans ce paquet)", async () => {
    configureGoogleMapsProvider({ apiKey: 'test-maps-key' });
    // Ni document ni window installés -- loadGoogleMaps() rejette, la promesse est absorbée.

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(<WebMapView center={{ latitude: 4.05, longitude: 9.7 }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
