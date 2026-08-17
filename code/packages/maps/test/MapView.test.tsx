/**
 * Test de rendu du fournisseur Google -- le seul test du paquet qui charge un double de
 * `react-native-maps` (`../__mocks__/react-native-maps.tsx`), activé explicitement ci-dessous.
 * Ni `navigation.ts`, ni `places.ts`, ni le fournisseur vide n'en ont besoin (critère
 * d'acceptation 4, L6-01).
 */
jest.mock('react-native-maps');

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { GoogleMapView } from '../src/providers/google/MapView';

test('rend une carte centrée avec ses marqueurs sans lever d\'erreur', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(
      <GoogleMapView
        center={{ latitude: 4.05, longitude: 9.7 }}
        markers={[
          { id: 'driver-1', kind: 'driver', position: { latitude: 4.051, longitude: 9.701 } },
        ]}
      />
    );
  });
});
