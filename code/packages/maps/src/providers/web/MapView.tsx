import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MapMarker, MapViewProps } from '../../types';
import { getGoogleMapsApiKey } from '../google/config';
import { loadGoogleMaps } from './loadGoogleMaps';
import { markerIconUrl } from './markerIcon';

/**
 * Troisième fournisseur de carte (L6-18, D22) -- Google Maps JavaScript, chargé à la demande.
 * Mêmes props que le fournisseur natif (`MapViewProps`, `types.ts`) : aucun écran ne sait lequel
 * des deux est monté (critère d'acceptation 6).
 *
 * Zoom par défaut à l'ouverture -- même raisonnement que `DEFAULT_DELTA` du fournisseur natif :
 * un réglage, pas un secret, conservé ici faute d'écran qui en aurait besoin en paramètre.
 */
const DEFAULT_ZOOM = 16;

export function WebMapView({ center, markers = [], route, onRegionChange, style }: MapViewProps) {
  // `View` (react-native-web) transmet son ref au noeud DOM sous-jacent au moment du montage
  // réel dans un navigateur -- ce que les types de `react-native` (natif) ne modélisent pas
  // (aucun paquet `react-native-web` en dépendance de type ici) : `any` assumé, jamais un import
  // de type supplémentaire pour une seule ligne.
  const containerRef = useRef<any>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const markerInstancesRef = useRef<GoogleMarker[]>([]);
  const polylineRef = useRef<GooglePolyline | null>(null);
  const [ready, setReady] = useState(false);

  // `center` n'est lu qu'au montage -- même sémantique que `initialRegion` du fournisseur natif
  // (providers/google/MapView.tsx) : un changement ultérieur de position ne doit pas faire
  // sauter la carte sous les doigts de l'utilisateur qui est justement en train de la faire
  // glisser (onRegionChange), sans quoi la boucle "je bouge la carte -> l'écran recalcule center
  // -> la carte se replace au centre d'origine" ne convergerait jamais.
  const initialCenterRef = useRef(center);
  const onRegionChangeRef = useRef(onRegionChange);
  onRegionChangeRef.current = onRegionChange;

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps(getGoogleMapsApiKey())
      .then(() => {
        if (cancelled) return;
        const container = containerRef.current as unknown as Element | null;
        const maps = window.google?.maps;
        if (!container || !maps) return;

        const map = new maps.Map(container, {
          center: { lat: initialCenterRef.current.latitude, lng: initialCenterRef.current.longitude },
          zoom: DEFAULT_ZOOM,
          disableDefaultUI: true,
          clickableIcons: false,
        });
        map.addListener('idle', () => {
          const nextCenter = map.getCenter();
          if (nextCenter) {
            onRegionChangeRef.current?.({ latitude: nextCenter.lat(), longitude: nextCenter.lng() });
          }
        });
        mapRef.current = map;
        setReady(true);
      })
      .catch(() => {
        // Dégradation déjà signalée à l'utilisateur (WebDemoBanner) -- aucun écran n'existe pour
        // afficher une erreur propre à ce paquet (même choix que providers/google/navigation.ts
        // face à l'absence d'app Maps).
      });

    return () => {
      cancelled = true;
    };
    // La position initiale est capturée une seule fois (initialCenterRef) -- volontairement hors
    // des dépendances, même règle que ci-dessus.
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || typeof window === 'undefined') return undefined;
    const maps = window.google?.maps;
    if (!maps) return undefined;

    markerInstancesRef.current.forEach((marker) => marker.setMap(null));
    markerInstancesRef.current = markers.map(
      (marker: MapMarker) =>
        new maps.Marker({
          position: { lat: marker.position.latitude, lng: marker.position.longitude },
          map,
          title: marker.label,
          icon: markerIconUrl(marker.kind),
        })
    );

    return () => {
      markerInstancesRef.current.forEach((marker) => marker.setMap(null));
      markerInstancesRef.current = [];
    };
  }, [ready, markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || typeof window === 'undefined') return undefined;
    const maps = window.google?.maps;
    if (!maps) return undefined;

    polylineRef.current?.setMap(null);
    polylineRef.current = route
      ? new maps.Polyline({
          path: route.points.map((point) => ({ lat: point.latitude, lng: point.longitude })),
          map,
          strokeColor: '#0A7D3D',
          strokeWeight: 4,
        })
      : null;

    return () => {
      polylineRef.current?.setMap(null);
    };
  }, [ready, route]);

  return <View ref={containerRef} style={style ?? styles.fill} />;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
