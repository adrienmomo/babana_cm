import React from 'react';
import { View } from 'react-native';

/**
 * Double de test pour `react-native-maps` -- même fichier que
 * `packages/maps/__mocks__/react-native-maps.tsx` et `apps/client/__mocks__/react-native-maps.tsx`
 * (voir ce dernier pour le détail du raisonnement). Adjacent à `node_modules` (racine du paquet
 * `@babana/driver`), Jest l'applique automatiquement, sans `jest.mock()` explicite.
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
