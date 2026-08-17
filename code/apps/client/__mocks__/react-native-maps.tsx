import React from 'react';
import { View } from 'react-native';

/**
 * Double de test pour `react-native-maps` -- même fichier que
 * `packages/maps/__mocks__/react-native-maps.tsx`, dupliqué ici pour la même raison qu'il existe
 * là-bas : `@babana/maps` réexporte `MapView` (donc le fournisseur Google, donc le SDK réel)
 * depuis son point d'entrée unique (`index.ts`), si bien qu'importer ne serait-ce que
 * `configureMapsProvider` depuis `src/bootstrap.ts` (L6-00) charge transitivement le SDK. Cette
 * app ne rend jamais de carte réelle dans ses tests (aucun écran métier ce soir) -- adjacent à
 * `node_modules` (racine du paquet `@babana/client`), Jest l'applique automatiquement, sans
 * `jest.mock()` explicite.
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
