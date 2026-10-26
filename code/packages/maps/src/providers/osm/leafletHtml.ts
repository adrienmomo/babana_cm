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

// Une couleur par rôle, jamais deux rôles de la même couleur : le chauffeur (vert de l'app), le
// point de prise en charge (bleu, comme le tracé qui y mène), l'arrivée (rouge adouci).
const MARKER_COLORS: Record<MapMarkerKind, string> = {
  driver: '#1A9E5C',
  client: '#3E7BFA',
  pickup: '#3E7BFA',
  dropoff: '#E5484D',
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
  var routeKey = null;
  var lastCenter = initial.center;
  var update = function (state) {
    layer.clearLayers();
    (state.markers || []).forEach(function (m) {
      var marker = L.circleMarker([m.position.latitude, m.position.longitude], {
        radius: 9, weight: 3, color: '#ffffff', fillColor: state.colors[m.kind] || '#0A7D3D', fillOpacity: 1
      });
      if (m.label) marker.bindTooltip(m.label);
      marker.addTo(layer);
    });
    var framed = false;
    if (state.route && state.route.points && state.route.points.length) {
      var pts = state.route.points;
      var line = L.polyline(pts.map(function (p) { return [p.latitude, p.longitude]; }),
        { color: '#3E7BFA', weight: 5, opacity: 0.9 }).addTo(layer);
      // Cadrer le tracé entier quand il change -- pas à chaque position du chauffeur, qui
      // arracherait la carte au doigt du chauffeur toutes les quelques secondes.
      var first = pts[0], last = pts[pts.length - 1];
      var key = pts.length + ':' + first.latitude + ',' + first.longitude + ':' + last.latitude + ',' + last.longitude;
      if (key !== routeKey) {
        routeKey = key;
        map.fitBounds(line.getBounds(), { padding: [48, 48], maxZoom: ${MAX_ZOOM - 3} });
        framed = true;
      }
    } else {
      routeKey = null;
    }
    // Recentrer seulement quand la PROP « centre » change -- pas dès que la carte diffère du
    // centre (le doigt du chauffeur, ou le cadrage d'un tracé, l'en écartent légitimement).
    var changed = Math.abs(lastCenter.latitude - state.center.latitude) > ${RECENTER_EPSILON} ||
      Math.abs(lastCenter.longitude - state.center.longitude) > ${RECENTER_EPSILON};
    lastCenter = state.center;
    if (changed && !framed) map.setView([state.center.latitude, state.center.longitude], map.getZoom());
  };
  // Seul un geste du doigt (glisser, pincer) est une désignation : un recentrage programmé (prop
  // « centre », cadrage d'un tracé) ne doit jamais être relayé comme un choix de l'utilisateur --
  // sinon l'arrivée se remplissait seule avec le départ à l'ouverture de l'accueil Client.
  var userGesture = false;
  var markGesture = function () { userGesture = true; };
  var container = map.getContainer();
  container.addEventListener('touchstart', markGesture, { passive: true });
  container.addEventListener('mousedown', markGesture);
  container.addEventListener('wheel', markGesture, { passive: true });
  map.on('moveend', function () {
    if (!userGesture) return;
    userGesture = false;
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
