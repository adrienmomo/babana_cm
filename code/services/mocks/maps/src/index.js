// mock-maps (L0-08) : doublures de routage et de recherche de lieu pour développer sans compte
// externe (D19). Les distances et durées sont sur un modèle voiture (É8 : ni Google ni Mapbox
// ne calculent d'itinéraire deux-roues au Cameroun) -- ce mock reproduit délibérément cette
// contrainte plutôt que de la corriger.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildRoute } = require('./routing');

if (process.env.NODE_ENV === 'production') {
  console.error('mock-maps refuse de démarrer : NODE_ENV=production (D19, critère 6 de L0-08).');
  process.exit(1);
}

const port = process.env.PORT || 4001;
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'douala.json'), 'utf8'));

/** Route de la recherche de lieu -- celle de Google Places API (New). */
const SEARCH_TEXT_PATH = '/v1/places:searchText';

/** Panne simulée à la demande (critère d'acceptation 4 de L0-08), pour tester L2-05. */
let failureSimulated = false;

function sendJson(res, status, body) {
  // CORS ouvert (D19, trouvé en vérifiant la correction de searchPlace dans un vrai navigateur,
  // J18) : GOOGLE_ROUTING_URL est appelé depuis Odoo (aucune notion de CORS, un serveur qui parle
  // à un autre), mais BABANA_MAPS_SEARCH_URL est appelé depuis le JavaScript d'un navigateur --
  // sans cet en-tête, la réponse arrive (curl la voit très bien) mais le navigateur refuse de la
  // livrer au code appelant. Un simulateur qui refuse de démarrer en production (ligne 10-13
  // ci-dessus) n'a aucune raison de restreindre son origine.
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', failureSimulated });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/_control/fail') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'corps JSON invalide' });
      return;
    }
    failureSimulated = Boolean(body.enabled);
    sendJson(res, 200, { failureSimulated });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/_control/status') {
    sendJson(res, 200, { failureSimulated });
    return;
  }

  // Préflight CORS : la recherche part d'un navigateur (export web, D22) en POST JSON avec des
  // en-têtes propres à Google -- le navigateur demande la permission avant d'envoyer.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Goog-Api-Key, X-Goog-FieldMask',
    });
    res.end();
    return;
  }

  if (failureSimulated && (url.pathname === '/route' || url.pathname === SEARCH_TEXT_PATH)) {
    sendJson(res, 503, { error: 'panne simulée (POST /_control/fail)' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/route') {
    const originLat = Number(url.searchParams.get('originLat'));
    const originLng = Number(url.searchParams.get('originLng'));
    const destLat = Number(url.searchParams.get('destLat'));
    const destLng = Number(url.searchParams.get('destLng'));
    if ([originLat, originLng, destLat, destLng].some((n) => Number.isNaN(n))) {
      sendJson(res, 400, { error: 'originLat, originLng, destLat, destLng requis' });
      return;
    }
    const route = buildRoute(
      { latitude: originLat, longitude: originLng },
      { latitude: destLat, longitude: destLng }
    );
    sendJson(res, 200, route);
    return;
  }

  // Même route et même forme que Google Places API (New), Text Search (`packages/maps`,
  // providers/google/places.ts) : une seule requête côté app, seule l'adresse change. Sans
  // résultat, Google renvoie `{}` -- ce mock aussi.
  if (req.method === 'POST' && url.pathname === SEARCH_TEXT_PATH) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let textQuery = '';
    try {
      textQuery = String(JSON.parse(raw || '{}').textQuery || '');
    } catch {
      sendJson(res, 400, { error: { code: 400, message: 'corps JSON invalide', status: 'INVALID_ARGUMENT' } });
      return;
    }
    const q = normalize(textQuery);
    const matches = q ? fixtures.places.filter((place) => normalize(place.name).includes(q)) : [];
    sendJson(
      res,
      200,
      matches.length === 0
        ? {}
        : {
            places: matches.map((place) => ({
              displayName: { text: place.name, languageCode: 'fr' },
              formattedAddress: `${place.name}, Douala, Cameroun`,
              location: { latitude: place.latitude, longitude: place.longitude },
            })),
          }
    );
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(port, () => {
  console.log(`mock-maps à l'écoute sur le port ${port} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});
