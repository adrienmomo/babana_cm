/**
 * Double de `react-native-maps` pour le bundle web (voir `webpack.config.js`, alias
 * `react-native-maps$`) -- provisoire, condamné par L6-18. Même forme que
 * `__mocks__/react-native-maps.tsx` (tests) : ni l'un ni l'autre ne rend une vraie carte, les
 * deux existent pour la même raison -- `@babana/maps` réexporte le fournisseur Google depuis son
 * point d'entrée unique, donc le charge dès qu'on importe `configureMapsProvider`.
 */
import React from 'react';
import { View } from 'react-native';

function StubMapView({ children, testID }) {
  return React.createElement(View, { testID: testID ?? 'stub-map-view' }, children);
}

function StubMarker({ testID }) {
  return React.createElement(View, { testID: testID ?? 'stub-map-marker' });
}

function StubPolyline({ testID }) {
  return React.createElement(View, { testID: testID ?? 'stub-map-polyline' });
}

export const PROVIDER_GOOGLE = 'google';
export const Marker = StubMarker;
export const Polyline = StubPolyline;
export default StubMapView;
