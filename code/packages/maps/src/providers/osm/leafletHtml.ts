import type { LatLng, MapMarker, MapRoute } from '../../types';
import { MAP_MARKER_COLORS } from '../../markerColors';

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
 * Repères dessinés en SVG dans la page (`L.divIcon`), jamais des images : l'icône par défaut de
 * Leaflet est un fichier relatif au CDN, qui n'existe pas dans une WebView à `baseUrl` neutre, et
 * un SVG reste net sur un écran dense. Un dessin par rôle (24 octobre) : épingle au départ et à
 * l'arrivée, moto pour un chauffeur, point pulsé pour le client.
 *
 * Netteté : une adresse de tuiles en `{r}` reçoit `@2x` de Leaflet sur un écran dense -- c'est au
 * fournisseur de servir ces tuiles. Pas de `detectRetina` : il demanderait des tuiles d'un niveau
 * de zoom au-dessus, quatre fois plus de données pour des libellés minuscules, sur un forfait compté.
 */
const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const DEFAULT_ZOOM = 15;
const MAX_ZOOM = 19;
/** En deçà de ce décalage (degrés, ~1 m), un « nouveau centre » est le même point -- évite la
 * boucle déplacement -> onRegionChange -> centre -> déplacement. */
export const RECENTER_EPSILON = 0.00001;

const MARKER_COLORS = MAP_MARKER_COLORS;

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

export function buildLeafletHtml(input: LeafletState & { tileUrlTemplate: string; tileAttribution: string }): string {
  const { tileUrlTemplate, tileAttribution, ...state } = input;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css" integrity="${LEAFLET_CSS_SRI}" crossorigin="" />
<style>
html,body,#map{height:100%;margin:0;padding:0;background:#ebe7df}
.leaflet-control-attribution{font-size:9px;line-height:12px;padding:0 4px;color:#6B7280;background:rgba(255,255,255,.6)!important}
.babana-marker{background:transparent;border:0}
.babana-marker svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.babana-moto{width:32px;height:50px;transform-origin:50% 50%;transition:transform .4s ease-out}
.babana-dot{position:relative;display:block;width:14px;height:14px;border-radius:50%;border:2px solid #fff;background:currentColor;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.babana-dot::after{content:'';position:absolute;left:-2px;top:-2px;width:18px;height:18px;border-radius:50%;background:currentColor;opacity:.45;animation:babana-pulse 2s ease-out infinite}
.babana-marker--reticle .babana-dot::after{display:none}
@keyframes babana-pulse{from{transform:scale(1);opacity:.45}to{transform:scale(3.2);opacity:0}}
</style>
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
    attribution: ${safeJson(tileAttribution)}
  }).addTo(map);

  // Épingle (départ, arrivée) : pointe sur le lieu exact par son extrémité basse.
  var pinSvg = function (color) {
    return '<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M15 1C7.3 1 1 7.2 1 14.9c0 10.4 12.6 23.1 13.1 23.6a1.3 1.3 0 0 0 1.8 0C16.4 38 29 25.3 29 14.9 29 7.2 22.7 1 15 1z" fill="' + color + '" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>';
  };
  // Moto vue de dessus avec son pilote, avant vers le haut (le nord) : roues, carénage à la
  // couleur du rôle, guidon, bras, épaules et casque. Tournée ensuite dans le sens de la marche.
  var motoSvg = function (color) {
    return '<svg width="32" height="50" viewBox="0 0 28 44" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="11.2" y="1" width="5.6" height="10" rx="2.8" fill="#1F2937"/>' +
      '<rect x="11.2" y="33" width="5.6" height="10" rx="2.8" fill="#1F2937"/>' +
      '<rect x="8.5" y="7" width="11" height="30" rx="5.5" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>' +
      '<rect x="2.5" y="10" width="23" height="2.8" rx="1.4" fill="#1F2937"/>' +
      '<path d="M6.4 22.5L4.6 12.4M21.6 22.5l1.8-10.1" stroke="#374151" stroke-width="2.8" stroke-linecap="round"/>' +
      '<ellipse cx="14" cy="24" rx="9" ry="5" fill="#374151" stroke="#fff" stroke-width="1"/>' +
      '<circle cx="14" cy="21.5" r="5.2" fill="#111827" stroke="#fff" stroke-width="1.2"/>' +
      '<path d="M10.6 19.4a4.2 4.2 0 0 1 6.8 0" fill="none" stroke="#9CA3AF" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg>';
  };
  // Cap (degrés, 0 = nord) du segment from -> to. Aucun cap n'arrive sur le fil côté client : on
  // le déduit du déplacement entre deux positions d'un même repère -- un affichage, jamais une
  // donnée métier.
  var bearingBetween = function (from, to) {
    var toRad = Math.PI / 180;
    var lat1 = from.latitude * toRad, lat2 = to.latitude * toRad;
    var dLng = (to.longitude - from.longitude) * toRad;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) / toRad + 360) % 360;
  };
  // Dernière position et dernier cap connus par repère : sous ~5 m de déplacement (bruit GPS,
  // arrêt), le cap précédent est gardé plutôt que de faire tourner la moto au hasard.
  var headings = {};
  var MIN_MOVE_DEG = 0.00005;
  var headingFor = function (m) {
    var prev = headings[m.id];
    if (!prev) {
      headings[m.id] = { position: m.position, bearing: 0 };
      return 0;
    }
    var moved = Math.abs(prev.position.latitude - m.position.latitude) > MIN_MOVE_DEG ||
      Math.abs(prev.position.longitude - m.position.longitude) > MIN_MOVE_DEG;
    if (moved) headings[m.id] = { position: m.position, bearing: bearingBetween(prev.position, m.position) };
    return headings[m.id].bearing;
  };
  // Une classe par rôle, écrite en toutes lettres (repérable dans la page comme dans le CSS).
  var KIND_CLASS = {
    pickup: 'babana-marker--pickup', dropoff: 'babana-marker--dropoff', driver: 'babana-marker--driver',
    client: 'babana-marker--client', reticle: 'babana-marker--reticle'
  };
  var iconFor = function (kind, color, bearing) {
    var cls = 'babana-marker ' + (KIND_CLASS[kind] || KIND_CLASS.client);
    if (kind === 'pickup' || kind === 'dropoff') {
      return L.divIcon({ className: cls, html: pinSvg(color), iconSize: [30, 40], iconAnchor: [15, 39], tooltipAnchor: [0, -34] });
    }
    if (kind === 'driver') {
      return L.divIcon({
        className: cls,
        html: '<div class="babana-moto" style="transform:rotate(' + Math.round(bearing || 0) + 'deg)">' + motoSvg(color) + '</div>',
        iconSize: [32, 50], iconAnchor: [16, 25], tooltipAnchor: [0, -25]
      });
    }
    // client (point pulsé) et réticule (point fixe).
    return L.divIcon({ className: cls, html: '<span class="babana-dot" style="color:' + color + '"></span>', iconSize: [18, 18], iconAnchor: [9, 9], tooltipAnchor: [0, -9] });
  };

  var layer = L.layerGroup().addTo(map);
  var routeKey = null;
  var lastCenter = initial.center;
  var update = function (state) {
    layer.clearLayers();
    (state.markers || []).forEach(function (m) {
      var isDriver = m.kind === 'driver';
      var marker = L.marker([m.position.latitude, m.position.longitude], {
        icon: iconFor(m.kind, state.colors[m.kind] || '#0A7D3D', isDriver ? headingFor(m) : 0),
        keyboard: false, interactive: !!m.label,
        // Le chauffeur passe toujours au-dessus des épingles : arrivé, il est exactement sur la
        // prise en charge, et c'est lui que l'on cherche des yeux.
        zIndexOffset: isDriver ? 1000 : 0
      });
      if (m.label) marker.bindTooltip(m.label, { direction: 'top' });
      marker.addTo(layer);
    });
    var framed = false;
    if (state.route && state.route.points && state.route.points.length) {
      var pts = state.route.points;
      var latlngs = pts.map(function (p) { return [p.latitude, p.longitude]; });
      // ROUTE_CASING : liseré blanc sous la ligne -- le tracé reste lisible sur un fond chargé.
      L.polyline(latlngs, { color: '#ffffff', weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
      // ROUTE_LINE
      var line = L.polyline(latlngs, { color: '#3E7BFA', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
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
