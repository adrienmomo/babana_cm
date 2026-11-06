import React from 'react';
import { View } from 'react-native';

/**
 * Double de test pour `react-native-maps` (L6-01, critère d'acceptation 4) -- activé
 * explicitement par `jest.mock('react-native-maps')` dans le seul test qui rend réellement
 * `<GoogleMapView>` (test/MapView.test.tsx). Le reste du paquet ne charge jamais ce module, réel
 * ou simulé.
 *
 * Les méthodes de caméra sont des `jest.fn` partagées (`__camera`) : c'est par elles qu'un test
 * voit la carte suivre un centre ou cadrer un tracé. `onRegionChangeComplete` est relayée telle
 * quelle, pour qu'un test simule un geste (`{ isGesture: true }`) ou un déplacement programmé.
 */
export const __camera = {
  animateCamera: jest.fn(),
  fitToCoordinates: jest.fn(),
};

interface MockMapViewProps {
  children?: React.ReactNode;
  testID?: string;
  onRegionChangeComplete?: (...args: unknown[]) => void;
}

const MockMapView = React.forwardRef<typeof __camera, MockMapViewProps>(function MockMapViewRender(
  { children, testID },
  ref
) {
  React.useImperativeHandle(ref, () => __camera);
  return <View testID={testID ?? 'mock-map-view'}>{children}</View>;
});

function MockMarker({ testID, children }: { testID?: string; children?: React.ReactNode }) {
  return <View testID={testID ?? 'mock-map-marker'}>{children}</View>;
}

function MockPolyline({ testID }: { testID?: string }) {
  return <View testID={testID ?? 'mock-map-polyline'} />;
}

function MockUrlTile({ testID }: { testID?: string }) {
  return <View testID={testID ?? 'mock-map-url-tile'} />;
}

export const PROVIDER_GOOGLE = 'google';
export const UrlTile = MockUrlTile;
export const Marker = MockMarker;
export const Polyline = MockPolyline;
export default MockMapView;
