import React from 'react';
import { View } from 'react-native';

/**
 * Double de test pour `react-native-maps` (L6-01, critère d'acceptation 4) -- activé
 * explicitement par `jest.mock('react-native-maps')` dans le seul test qui rend réellement
 * `<GoogleMapView>` (providers/google/MapView.test.tsx). Le reste du paquet ne charge jamais ce
 * module, réel ou simulé.
 */
function MockMapView({ children, testID }: { children?: React.ReactNode; testID?: string }) {
  return <View testID={testID ?? 'mock-map-view'}>{children}</View>;
}

function MockMarker({ testID }: { testID?: string }) {
  return <View testID={testID ?? 'mock-map-marker'} />;
}

function MockPolyline({ testID }: { testID?: string }) {
  return <View testID={testID ?? 'mock-map-polyline'} />;
}

export const PROVIDER_GOOGLE = 'google';
export const Marker = MockMarker;
export const Polyline = MockPolyline;
export default MockMapView;
