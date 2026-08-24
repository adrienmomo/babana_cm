/**
 * Page publique de partage de trajet (L8-03). Servie par ce service, pas par Odoo -- rien à
 * construire (pas de bundler ici), un seul fichier HTML avec CSS et JS inline. Volontairement
 * sans dépendance de carte : `@babana/maps` est pensé pour React Native/le bundle web de l'app
 * (D22), pas pour une page HTML autonome sans étape de build, et une bibliothèque de tuiles
 * (Leaflet, MapLibre) ajouterait une dépendance externe non plus qu'un mock ne couvre pas
 * (CLAUDE.md, "aucune dépendance nouvelle sans nécessité"). À la place : un repère SVG minimal
 * (deux points, chauffeur et destination, mis à l'échelle de leur propre boîte englobante à
 * chaque rafraîchissement) -- pas un fond de carte, mais assez pour voir le trajet se rapprocher,
 * sans le moindre appel réseau supplémentaire ni le moindre kilo-octet de bibliothèque.
 *
 * "Navigateur d'entrée de gamme, réseau lent" (spécification) : une seule requête de statut par
 * cycle d'actualisation (`/s/{token}/status`), aucune police ni image externe.
 */

const SHELL_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #F9FAFB; color: #111827;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #6B7280; font-size: 13px; margin: 0 0 16px; }
  .card {
    background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px;
    padding: 14px; margin-bottom: 12px;
  }
  .driver { font-weight: 600; }
  .eta { font-size: 20px; font-weight: 700; color: #0A7D3D; margin-top: 4px; }
  svg { width: 100%; height: 180px; background: #F3F4F6; border-radius: 8px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .badge-course { background: #DBEAFE; color: #1D4ED8; }
  .badge-approach { background: #FEF3C7; color: #92400E; }
  .ended { text-align: center; padding: 40px 16px; color: #6B7280; }
`;

const ACTIVE_SCRIPT = `
function escapeHtml(value) {
  var div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
function haversine(a, b) {
  var R = 6371000, toRad = function (d) { return (d * Math.PI) / 180; };
  var dLat = toRad(b.latitude - a.latitude), dLng = toRad(b.longitude - a.longitude);
  var h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatEta(seconds) {
  if (seconds === null || seconds === undefined) return null;
  var minutes = Math.max(1, Math.round(seconds / 60));
  return minutes + ' min';
}
function project(point, box) {
  var padX = (box.maxLng - box.minLng) * 0.2 || 0.001;
  var padY = (box.maxLat - box.minLat) * 0.2 || 0.001;
  var x = ((point.longitude - (box.minLng - padX)) / ((box.maxLng + padX) - (box.minLng - padX))) * 300;
  var y = 200 - ((point.latitude - (box.minLat - padY)) / ((box.maxLat + padY) - (box.minLat - padY))) * 200;
  return { x: x, y: y };
}
function render(status) {
  var root = document.getElementById('root');
  if (!status.active) {
    root.innerHTML = '<div class="ended card"><p>Ce trajet est terminé.</p></div>';
    return;
  }
  var driverName = status.driverFirstName || 'Le chauffeur';
  var badge = status.phase === 'course'
    ? '<span class="badge badge-course">Course en cours</span>'
    : '<span class="badge badge-approach">En approche</span>';
  var etaLine = '';
  if (status.phase === 'approach' && status.position) {
    var etaSeconds = status.etaSeconds;
    var eta = formatEta(etaSeconds);
    if (eta) etaLine = '<div class="eta">Arrivée dans ' + eta + '</div>';
  }
  var svg = '';
  var targetLabel = status.phase === 'course' ? "Distance jusqu'à l'arrivée : " : "Distance jusqu'au point de rendez-vous : ";
  if (status.position && status.target) {
    var box = {
      minLat: Math.min(status.position.latitude, status.target.latitude),
      maxLat: Math.max(status.position.latitude, status.target.latitude),
      minLng: Math.min(status.position.longitude, status.target.longitude),
      maxLng: Math.max(status.position.longitude, status.target.longitude),
    };
    var driverPoint = project(status.position, box);
    var targetPoint = project(status.target, box);
    var distance = Math.round(haversine(status.position, status.target));
    svg = '<svg viewBox="0 0 300 200">' +
      '<line x1="' + driverPoint.x + '" y1="' + driverPoint.y + '" x2="' + targetPoint.x + '" y2="' + targetPoint.y + '" stroke="#9CA3AF" stroke-width="2" stroke-dasharray="4 4"/>' +
      '<circle cx="' + targetPoint.x + '" cy="' + targetPoint.y + '" r="7" fill="#DC2626"/>' +
      '<circle cx="' + driverPoint.x + '" cy="' + driverPoint.y + '" r="7" fill="#0A7D3D"/>' +
      '</svg>' +
      '<p class="sub">' + targetLabel + (distance / 1000).toFixed(1) + ' km</p>';
  } else {
    svg = '<p class="sub">En attente de la position du chauffeur…</p>';
  }
  root.innerHTML =
    '<div class="card">' +
    '<div class="driver">' + escapeHtml(driverName) + '</div>' +
    '<div class="sub">' + (status.motorcycleClass === 'premium' ? 'Moto premium' : 'Moto standard') + ' &middot; ' + badge + '</div>' +
    etaLine +
    '</div>' +
    '<div class="card">' + svg + '</div>';
}
function poll() {
  fetch(window.__SHARE_STATUS_URL__)
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () {});
}
poll();
setInterval(poll, window.__SHARE_POLL_INTERVAL_MS__);
`;

export function renderSharePage(options: { token: string; pollIntervalSeconds: number; initialActive: boolean }): string {
  const statusUrl = `/s/${encodeURIComponent(options.token)}/status`;
  const body = options.initialActive
    ? '<div id="root"><p class="sub">Chargement…</p></div>'
    : '<div id="root"><div class="ended card"><p>Ce trajet est terminé.</p></div></div>';
  const script = options.initialActive
    ? `<script>window.__SHARE_STATUS_URL__=${JSON.stringify(statusUrl)};window.__SHARE_POLL_INTERVAL_MS__=${
        options.pollIntervalSeconds * 1000
      };${ACTIVE_SCRIPT}</script>`
    : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Trajet babana</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<h1>Suivi du trajet</h1>
<p class="sub">Partagé depuis babana.cm</p>
${body}
${script}
</body>
</html>`;
}

export function renderShareNotFoundPage(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Trajet babana</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<h1>Suivi du trajet</h1>
<div class="ended card"><p>Ce lien n'est plus valide.</p></div>
</body>
</html>`;
}
