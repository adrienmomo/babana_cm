import type { LatLng, MapMarker, MapMarkerKind, MapRoute } from '../../types';

/**
 * Page Leaflet servie à la WebView. Tout ce qui varie (centre, repères, tracé, adresse des tuiles)
 * entre par `JSON.stringify` -- jamais concaténé dans le code de la page -- avec les « < » échappés
 * (`<`) : un libellé de repère contenant `</script>` ne peut ainsi pas sortir de la balise.
 *
 * Leaflet vient d'une version **épinglée** du CDN (jamais « latest ») avec son empreinte
 * d'intégrité : une page qui charge du code exécutable sans le vérifier est une porte ouverte.
 * Limite connue, à traiter avant le pilote : hors connexion, la page ne charge pas Leaflet (les
 * tuiles non plus, mais Leaflet pourrait être embarqué dans l'APK).
 *
 * Repères = `circleMarker` colorés, pas d'images : l'icône par défaut de Leaflet est un fichier
 * relatif au CDN, qui n'existe pas dans une WebView à `baseUrl` neutre.
 */
const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const DEFAULT_ZOOM = 15;
const MAX_ZOOM = 19;
/** En deçà de ce décalage (degrés, ~1 m), un « nouveau centre » est le même point -- évite la
 * boucle déplacement -> onRegionChange -> centre -> déplacement. */
export const RECENTER_EPSILON = 0.00001;

const MARKER_COLORS: Record<MapMarkerKind, string> = {
  driver: '#0A7D3D',
  client: '#1D4ED8',
  pickup: '#0A7D3D',
  dropoff: '#B91C1C',
  reticle: '#6B7280',
};

export interface LeafletState {
  center: LatLng;
  markers: MapMarker[];
  route?: MapRoute;
}

/** JSON sûr à l'intérieur d'une balise <script> et d'une chaîne injectée. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Code à injecter dans la page pour la mettre à jour sans la recharger. */
export function updateScript(state: LeafletState): string {
  return `window.babana && window.babana.update(${safeJson({ ...state, colors: MARKER_COLORS })}); true;`;
}

export function buildLeafletHtml(input: LeafletState & { tileUrlTemplate: string }): string {
  const { tileUrlTemplate, ...state } = input;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css" integrity="${LEAFLET_CSS_SRI}" crossorigin="" />
<style>html,body,#map{height:100%;margin:0;padding:0;background:#ebe7df}</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js" integrity="${LEAFLET_JS_SRI}" crossorigin=""></script>
<script>
(function () {
  var post = function (message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var initial = ${safeJson({ ...state, colors: MARKER_COLORS })};
  var map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView([initial.center.latitude, initial.center.longitude], ${DEFAULT_ZOOM});
  map.attributionControl.setPrefix(false);
  L.tileLayer(${safeJson(tileUrlTemplate)}, {
    maxZoom: ${MAX_ZOOM},
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var layer = L.layerGroup().addTo(map);
  var update = function (state) {
    layer.clearLayers();
    (state.markers || []).forEach(function (m) {
      var marker = L.circleMarker([m.position.latitude, m.position.longitude], {
        radius: 9, weight: 3, color: '#ffffff', fillColor: state.colors[m.kind] || '#0A7D3D', fillOpacity: 1
      });
      if (m.label) marker.bindTooltip(m.label);
      marker.addTo(layer);
    });
    if (state.route && state.route.points && state.route.points.length) {
      L.polyline(state.route.points.map(function (p) { return [p.latitude, p.longitude]; }),
        { color: '#0A7D3D', weight: 4 }).addTo(layer);
    }
    var c = map.getCenter();
    if (Math.abs(c.lat - state.center.latitude) > ${RECENTER_EPSILON} || Math.abs(c.lng - state.center.longitude) > ${RECENTER_EPSILON}) {
      map.setView([state.center.latitude, state.center.longitude], map.getZoom());
    }
  };
  map.on('moveend', function () {
    var c = map.getCenter();
    post({ type: 'moveend', latitude: c.lat, longitude: c.lng });
  });
  window.babana = { update: update };
  update(initial);
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
