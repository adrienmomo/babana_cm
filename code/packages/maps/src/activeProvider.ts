import React from 'react';
import type { MapProvider, MapViewProps } from './types';
import { googleMapProvider } from './providers/google';
import { OsmMapView } from './providers/osm/MapView';
import { getMapTiles } from './providers/osm/config';

/**
 * Le seul endroit qui choisit un fournisseur concret. Natif : la carte est celle d'OpenStreetMap
 * quand l'app a configuré une adresse de tuiles (`configureMapsProvider({ tileUrl })`), celle de
 * Google sinon ; la recherche de lieu, le géocodage inverse et la navigation restent ceux de
 * Google dans les deux cas. Le choix se lit au rendu, ici -- jamais dans un écran (critère
 * d'acceptation 6 de L6-18, "aucune branche conditionnelle dans les écrans").
 * `MapView.tsx`, `navigation.ts` et `places.ts` ne font que relayer `activeMapProvider`.
 */
function ConfiguredMapView(props: MapViewProps) {
  const tiles = getMapTiles();
  return tiles
    ? React.createElement(OsmMapView, { ...props, tileUrlTemplate: tiles.url, tileAttribution: tiles.attribution })
    : React.createElement(googleMapProvider.MapView, props);
}

export const activeMapProvider: MapProvider = { ...googleMapProvider, MapView: ConfiguredMapView };
