import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import RNMapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { Details, Region } from 'react-native-maps';
import type { LatLng, MapMarker, MapMarkerKind, MapRoute, MapViewProps } from '../../types';
import { MAP_MARKER_COLORS } from '../../markerColors';
import { RECENTER_EPSILON, createHeadingTracker } from '../../heading';

/**
 * Seul fichier du paquet, avec `navigation.ts` et `places.ts`, qui importe `react-native-maps` --
 * autorisé par le lint uniquement sous `providers/` (critère d'acceptation 2, `.eslintrc.cjs`).
 * Aucun type du SDK (`Region`, `Marker`...) ne sort de ce fichier : les props publiques
 * (`MapViewProps`, `types.ts`) n'en connaissent aucun (critère d'acceptation 1).
 *
 * Se comporte comme la carte Leaflet (`providers/osm/leafletHtml.ts`) -- constaté le 6 novembre :
 * tout ce qui y avait été corrigé fin octobre manquait ici, et les apps l'ont perdu dès qu'une
 * vraie clé Google a remplacé les tuiles OpenStreetMap :
 *   - seul un geste du doigt est relayé par `onRegionChange` (b74dcde) ;
 *   - la caméra suit la prop `center`, et cadre un nouvel itinéraire en entier ;
 *   - un dessin par rôle (3f9a235) : épingle au départ et à l'arrivée, moto orientée pour le
 *     chauffeur, point pour le client ; tracé bleu sur liseré blanc.
 * Les repères sont des vues React Native, pas des images ni du SVG : aucune dépendance de plus.
 */

const DEFAULT_DELTA = 0.01;
const CAMERA_DURATION_MS = 400;
const ROUTE_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
const ROUTE_CASING = { color: '#ffffff', width: 9 };
const ROUTE_LINE = { color: '#3E7BFA', width: 5 };
const DRIVER_Z_INDEX = 1000;
// Une vue de repère personnalisée doit être retracée tant qu'elle se met en page (sinon Android
// l'affiche vide), puis plus jamais : retracer chaque repère à chaque image coûte la batterie.
const MARKER_SETTLE_MS = 500;

function routeKeyOf(route: MapRoute | undefined): string | null {
  const points = route?.points ?? [];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  return `${points.length}:${first.latitude},${first.longitude}:${last.latitude},${last.longitude}`;
}

function sameCenter(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.latitude - b.latitude) <= RECENTER_EPSILON && Math.abs(a.longitude - b.longitude) <= RECENTER_EPSILON;
}

function MarkerBody({ kind }: { kind: MapMarkerKind }) {
  const color = MAP_MARKER_COLORS[kind];
  if (kind === 'pickup' || kind === 'dropoff') {
    return (
      <View style={styles.pin}>
        <View testID={`babana-marker-${kind}`} style={[styles.pinHead, { backgroundColor: color }]}>
          <View style={styles.pinHole} />
        </View>
      </View>
    );
  }
  if (kind === 'driver') {
    // Moto vue de dessus, mêmes proportions que le SVG de Leaflet (28 x 44 -> 32 x 50).
    return (
      <View style={styles.moto}>
        <View style={[styles.motoWheel, styles.motoWheelFront]} />
        <View style={[styles.motoWheel, styles.motoWheelRear]} />
        <View testID="babana-marker-driver" style={[styles.motoBody, { backgroundColor: color }]} />
        <View style={styles.motoHandlebar} />
        <View style={styles.motoRider} />
        <View style={styles.motoHelmet} />
      </View>
    );
  }
  return (
    <View style={styles.dotBox}>
      <View testID={`babana-marker-${kind}`} style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

function BabanaMarker({ marker, rotation }: { marker: MapMarker; rotation: number }) {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setTracksViewChanges(false), MARKER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  const isDriver = marker.kind === 'driver';
  const isPin = marker.kind === 'pickup' || marker.kind === 'dropoff';
  return (
    <Marker
      identifier={marker.id}
      coordinate={marker.position}
      title={marker.label}
      anchor={isPin ? { x: 0.5, y: 1 } : { x: 0.5, y: 0.5 }}
      // La moto tourne avec la carte (vue de dessus) : `flat`, et le cap en degrés depuis le nord.
      flat={isDriver}
      rotation={isDriver ? rotation : 0}
      zIndex={isDriver ? DRIVER_Z_INDEX : 1}
      tracksViewChanges={tracksViewChanges}
    >
      <MarkerBody kind={marker.kind} />
    </Marker>
  );
}

export function GoogleMapView({ center, markers = [], route, onRegionChange, frameRoute = true, style }: MapViewProps) {
  const mapRef = useRef<RNMapView | null>(null);
  const lastCenter = useRef<LatLng>(center);
  const routeKey = useRef<string | null>(null);
  const headingFor = useRef(createHeadingTracker()).current;

  // Cadrer un itinéraire quand il change -- puis suivre le centre. Même règle que Leaflet : dans
  // la mise à jour où un tracé est cadré, le centre n'arrache pas ce cadrage.
  useEffect(() => {
    let framed = false;
    const key = routeKeyOf(route);
    if (frameRoute && key && route && key !== routeKey.current) {
      mapRef.current?.fitToCoordinates(route.points, { edgePadding: ROUTE_PADDING, animated: true });
      framed = true;
    }
    routeKey.current = key;
    const changed = !sameCenter(lastCenter.current, center);
    lastCenter.current = center;
    if (changed && !framed) {
      // Le centre seul : le zoom reste celui que le chauffeur ou le cadrage a choisi.
      mapRef.current?.animateCamera({ center }, { duration: CAMERA_DURATION_MS });
    }
  }, [center, route, frameRoute]);

  return (
    <RNMapView
      ref={mapRef}
      provider={PROVIDER_GOOGLE}
      style={style ?? styles.fill}
      initialRegion={{
        latitude: center.latitude,
        longitude: center.longitude,
        latitudeDelta: DEFAULT_DELTA,
        longitudeDelta: DEFAULT_DELTA,
      }}
      onMapReady={() => {
        // Un tracé présent dès l'ouverture a pu être cadré avant que la carte n'ait une taille.
        if (frameRoute && route && route.points.length > 0) {
          mapRef.current?.fitToCoordinates(route.points, { edgePadding: ROUTE_PADDING, animated: false });
        }
      }}
      onRegionChangeComplete={(region: Region, details?: Details) => {
        // Seul un geste du doigt est une désignation : un recentrage programmé (prop « centre »,
        // cadrage d'un tracé, ouverture de l'écran) ne doit jamais remplir un champ à la place de
        // l'utilisateur (b74dcde, constaté de nouveau le 6 novembre avec Google).
        if (!details?.isGesture) return;
        onRegionChange?.({ latitude: region.latitude, longitude: region.longitude });
      }}
    >
      {route ? (
        <>
          <Polyline
            coordinates={route.points}
            strokeWidth={ROUTE_CASING.width}
            strokeColor={ROUTE_CASING.color}
            lineCap="round"
            lineJoin="round"
            zIndex={0}
          />
          <Polyline
            coordinates={route.points}
            strokeWidth={ROUTE_LINE.width}
            strokeColor={ROUTE_LINE.color}
            lineCap="round"
            lineJoin="round"
            zIndex={1}
          />
        </>
      ) : null}
      {markers.map((marker) => (
        <BabanaMarker
          key={marker.id}
          marker={marker}
          rotation={marker.kind === 'driver' ? headingFor(marker.id, marker.position) : 0}
        />
      ))}
    </RNMapView>
  );
}

const WHITE = '#ffffff';
const DARK = '#1F2937';

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  // Épingle : une goutte (carré aux trois coins arrondis, tourné de 45°) dont la pointe touche le lieu.
  pin: { width: 30, height: 38, alignItems: 'center' },
  pinHead: {
    width: 26,
    height: 26,
    marginTop: 2,
    borderTopLeftRadius: 13,
    borderTopRightRadius: 13,
    borderBottomLeftRadius: 13,
    borderBottomRightRadius: 0,
    borderWidth: 2,
    borderColor: WHITE,
    transform: [{ rotate: '45deg' }],
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinHole: { width: 10, height: 10, borderRadius: 5, backgroundColor: WHITE },
  moto: { width: 32, height: 50 },
  motoWheel: { position: 'absolute', left: 12.8, width: 6.4, height: 11.4, borderRadius: 3.2, backgroundColor: DARK },
  motoWheelFront: { top: 1 },
  motoWheelRear: { top: 37.6 },
  motoBody: {
    position: 'absolute',
    left: 9.7,
    top: 8,
    width: 12.6,
    height: 34,
    borderRadius: 6.3,
    borderWidth: 1.5,
    borderColor: WHITE,
  },
  motoHandlebar: { position: 'absolute', left: 2.9, top: 11.4, width: 26.2, height: 3.2, borderRadius: 1.6, backgroundColor: DARK },
  motoRider: {
    position: 'absolute',
    left: 5.7,
    top: 21.7,
    width: 20.6,
    height: 11.4,
    borderRadius: 5.7,
    backgroundColor: '#374151',
    borderWidth: 1,
    borderColor: WHITE,
  },
  motoHelmet: {
    position: 'absolute',
    left: 10.1,
    top: 18.7,
    width: 11.8,
    height: 11.8,
    borderRadius: 5.9,
    backgroundColor: '#111827',
    borderWidth: 1.2,
    borderColor: WHITE,
  },
  dotBox: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: WHITE },
});
