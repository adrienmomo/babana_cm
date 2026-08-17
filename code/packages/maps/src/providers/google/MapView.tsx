import React from 'react';
import { StyleSheet } from 'react-native';
import RNMapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import type { MapMarkerKind, MapViewProps } from '../../types';

/**
 * Seul fichier du paquet, avec `navigation.ts` et `places.ts`, qui importe `react-native-maps` --
 * autorisé par le lint uniquement sous `providers/` (critère d'acceptation 2, `.eslintrc.cjs`).
 * Aucun type du SDK (`Region`, `Marker`...) ne sort de ce fichier : les props publiques
 * (`MapViewProps`, `types.ts`) n'en connaissent aucun (critère d'acceptation 1).
 */

// Zoom par défaut à l'ouverture -- une valeur métier (rayon d'affichage), pas un secret, mais
// tout de même un réglage : conservé ici plutôt que remonté en paramètre, faute d'écran qui en
// aurait besoin ce soir (aucun écran cartographique n'existe encore, L6-01).
const DEFAULT_DELTA = 0.01;

function colorFor(kind: MapMarkerKind): string {
  switch (kind) {
    case 'driver':
      return '#0A7D3D';
    case 'client':
      return '#1D4ED8';
    case 'pickup':
      return '#0A7D3D';
    case 'dropoff':
      return '#B91C1C';
    case 'reticle':
      return '#6B7280';
  }
}

export function GoogleMapView({ center, markers = [], route, onRegionChange, style }: MapViewProps) {
  return (
    <RNMapView
      provider={PROVIDER_GOOGLE}
      style={style ?? styles.fill}
      initialRegion={{
        latitude: center.latitude,
        longitude: center.longitude,
        latitudeDelta: DEFAULT_DELTA,
        longitudeDelta: DEFAULT_DELTA,
      }}
      onRegionChangeComplete={(region: Region) =>
        onRegionChange?.({ latitude: region.latitude, longitude: region.longitude })
      }
    >
      {markers.map((marker) => (
        <Marker
          key={marker.id}
          coordinate={marker.position}
          title={marker.label}
          pinColor={colorFor(marker.kind)}
        />
      ))}
      {route ? <Polyline coordinates={route.points} strokeWidth={4} strokeColor="#0A7D3D" /> : null}
    </RNMapView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
