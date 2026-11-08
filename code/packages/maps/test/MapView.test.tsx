/**
 * Test de rendu du fournisseur Google -- le seul test du paquet qui charge un double de
 * `react-native-maps` (`../__mocks__/react-native-maps.tsx`), activé explicitement ci-dessous.
 * Ni `navigation.ts`, ni `places.ts`, ni le fournisseur vide n'en ont besoin (critère
 * d'acceptation 4, L6-01).
 *
 * Depuis le 6 novembre, le fournisseur Google natif doit se comporter comme la carte Leaflet
 * (`providers/osm/leafletHtml.ts`) : ces comportements n'avaient été corrigés que là, et les apps
 * les ont tous perdus dès qu'une vraie clé Google a remplacé les tuiles OpenStreetMap.
 */
jest.mock('react-native-maps');
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import RNMapView, { Marker, Polyline, __camera } from 'react-native-maps';
import { GoogleMapView } from '../src/providers/google/MapView';
import { MAP_MARKER_COLORS } from '../src/markerColors';
import type { MapViewProps } from '../src/types';

const DOUALA = { latitude: 4.05, longitude: 9.7 };

// Démontées après chaque test : un repère arme un minuteur (fin du retraçage de sa vue).
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function render(props: MapViewProps) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<GoogleMapView {...props} />);
  });
  mounted.push(renderer);
  return {
    renderer,
    rerender: async (next: MapViewProps) => {
      await ReactTestRenderer.act(() => {
        renderer.update(<GoogleMapView {...next} />);
      });
    },
  };
}

beforeEach(() => {
  __camera.animateCamera.mockClear();
  __camera.fitToCoordinates.mockClear();
});

afterEach(async () => {
  await ReactTestRenderer.act(() => {
    mounted.splice(0).forEach((renderer) => renderer.unmount());
  });
});

test('rend une carte centrée avec ses marqueurs sans lever d\'erreur', async () => {
  await render({
    center: DOUALA,
    markers: [{ id: 'driver-1', kind: 'driver', position: { latitude: 4.051, longitude: 9.701 } }],
  });
});

describe('seul un geste du doigt est une désignation (parité b74dcde)', () => {
  // Sans cela, l'ouverture de l'accueil Client, ou tout recentrage programmé, remplissait l'arrivée
  // avec le point sous le repère -- constaté le 6 novembre : « Marché Sandaga » redevenu
  // « vers 3Q29+C5R » au retour du devis.
  test.each([
    ['un déplacement programmé', { isGesture: false }],
    ['un déplacement sans détail', undefined],
  ])('%s n\'est jamais relayé', async (_label, details) => {
    const onRegionChange = jest.fn();
    const { renderer } = await render({ center: DOUALA, onRegionChange });
    await ReactTestRenderer.act(() => {
      renderer.root.findByType(RNMapView).props.onRegionChangeComplete(
        { latitude: 4.06, longitude: 9.71, latitudeDelta: 0.01, longitudeDelta: 0.01 },
        details
      );
    });
    expect(onRegionChange).not.toHaveBeenCalled();
  });

  test('un geste est relayé avec le centre atteint', async () => {
    const onRegionChange = jest.fn();
    const { renderer } = await render({ center: DOUALA, onRegionChange });
    await ReactTestRenderer.act(() => {
      renderer.root.findByType(RNMapView).props.onRegionChangeComplete(
        { latitude: 4.06, longitude: 9.71, latitudeDelta: 0.01, longitudeDelta: 0.01 },
        { isGesture: true }
      );
    });
    expect(onRegionChange).toHaveBeenCalledWith({ latitude: 4.06, longitude: 9.71 });
  });
});

describe('la carte suit le centre', () => {
  test('un nouveau centre déplace la caméra, sans changer le zoom', async () => {
    const { rerender } = await render({ center: DOUALA });
    expect(__camera.animateCamera).not.toHaveBeenCalled();
    await rerender({ center: { latitude: 4.052, longitude: 9.703 } });
    expect(__camera.animateCamera).toHaveBeenCalledTimes(1);
    const [camera] = __camera.animateCamera.mock.calls[0];
    expect(camera).toEqual({ center: { latitude: 4.052, longitude: 9.703 } });
  });

  test('un centre identique à un mètre près ne déplace rien', async () => {
    const { rerender } = await render({ center: DOUALA });
    await rerender({ center: { latitude: 4.050001, longitude: 9.700001 } });
    expect(__camera.animateCamera).not.toHaveBeenCalled();
  });
});

describe('itinéraire', () => {
  const route = {
    points: [
      { latitude: 4.0436, longitude: 9.6935 },
      { latitude: 4.05, longitude: 9.698 },
      { latitude: 4.0615, longitude: 9.7025 },
    ],
  };

  test('un nouvel itinéraire est cadré en entier, une seule fois', async () => {
    const { rerender } = await render({ center: DOUALA, route });
    expect(__camera.fitToCoordinates).toHaveBeenCalledTimes(1);
    expect(__camera.fitToCoordinates.mock.calls[0][0]).toEqual(route.points);
    // Même tracé, le chauffeur avance : la carte le suit, sans recadrer.
    await rerender({ center: { latitude: 4.046, longitude: 9.695 }, route });
    expect(__camera.fitToCoordinates).toHaveBeenCalledTimes(1);
    expect(__camera.animateCamera).toHaveBeenCalledTimes(1);
  });

  test('frameRoute={false} : jamais de cadrage, la carte suit seulement le centre', async () => {
    // Carte du chauffeur (demande du 6 novembre) : son itinéraire est recalculé dès qu'il s'en
    // écarte, et chaque recadrage le rejetait au bord de l'écran.
    const { rerender } = await render({ center: DOUALA, route, frameRoute: false });
    expect(__camera.fitToCoordinates).not.toHaveBeenCalled();
    const rerouted = { points: [{ latitude: 4.046, longitude: 9.695 }, ...route.points.slice(1)] };
    await rerender({ center: { latitude: 4.046, longitude: 9.695 }, route: rerouted, frameRoute: false });
    expect(__camera.fitToCoordinates).not.toHaveBeenCalled();
    expect(__camera.animateCamera).toHaveBeenCalledTimes(1);
    expect(__camera.animateCamera.mock.calls[0][0]).toEqual({ center: { latitude: 4.046, longitude: 9.695 } });
  });

  test('tracé blanc dessous, ligne bleue dessus -- comme Leaflet', async () => {
    const { renderer } = await render({ center: DOUALA, route });
    const lines = renderer.root.findAllByType(Polyline).map((line) => line.props);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ strokeColor: '#ffffff', strokeWidth: 9 });
    expect(lines[1]).toMatchObject({ strokeColor: '#3E7BFA', strokeWidth: 5 });
    expect(lines[1].zIndex).toBeGreaterThan(lines[0].zIndex);
  });
});

describe('repères dessinés par rôle (parité 3f9a235)', () => {
  test('épingle au départ et à l\'arrivée, moto pour le chauffeur, point pour le client', async () => {
    const { renderer } = await render({
      center: DOUALA,
      markers: [
        { id: 'p', kind: 'pickup', position: { latitude: 4.0436, longitude: 9.6935 } },
        { id: 'd', kind: 'dropoff', position: { latitude: 4.0615, longitude: 9.7025 } },
        { id: 'me', kind: 'driver', position: DOUALA },
        { id: 'c', kind: 'client', position: { latitude: 4.044, longitude: 9.694 } },
      ],
    });
    for (const kind of ['pickup', 'dropoff', 'driver', 'client'] as const) {
      const body = renderer.root.findByProps({ testID: `babana-marker-${kind}` });
      expect(body.props.accessibilityLabel).toBeUndefined();
      expect(JSON.stringify(body.props.style)).toContain(MAP_MARKER_COLORS[kind]);
    }
    const byId = Object.fromEntries(renderer.root.findAllByType(Marker).map((m) => [m.props.identifier, m.props]));
    // Pointe de l'épingle sur le lieu ; moto centrée sur sa position.
    expect(byId.p.anchor).toEqual({ x: 0.5, y: 1 });
    expect(byId.me.anchor).toEqual({ x: 0.5, y: 0.5 });
    // Le chauffeur passe au-dessus des épingles : arrivé, il est exactement sur la prise en charge.
    expect(byId.me.zIndex).toBeGreaterThan(byId.p.zIndex);
  });

  test('la moto s\'oriente dans le sens du déplacement', async () => {
    const driverAt = (position: { latitude: number; longitude: number }): MapViewProps => ({
      center: DOUALA,
      markers: [{ id: 'me', kind: 'driver', position }],
    });
    const { renderer, rerender } = await render(driverAt(DOUALA));
    const rotation = () => renderer.root.findAllByType(Marker)[0].props.rotation;
    expect(rotation()).toBe(0);
    // Vers l'est.
    await rerender(driverAt({ latitude: 4.05, longitude: 9.701 }));
    expect(rotation()).toBeCloseTo(90, 0);
    // Un relevé immobile (bruit GPS) garde le dernier cap.
    await rerender(driverAt({ latitude: 4.050001, longitude: 9.701001 }));
    expect(rotation()).toBeCloseTo(90, 0);
    expect(renderer.root.findAllByType(Marker)[0].props.flat).toBe(true);
  });
});
