// mock-google-identity (L0-08) : émule le point de vérification Google, jamais notre logique
// (D19). Le contrôleur d'authentification (L1-01, hors du lot de cette nuit) vérifiera une
// vraie signature RS256 contre un vrai jeu de clés JWKS -- seul GOOGLE_JWKS_URL change entre
// développement et production, aucune branche `if development` dans le code de vérification.
const http = require('node:http');
const crypto = require('node:crypto');
const { primary, rogue, jwks } = require('./keys');
const { signRS256 } = require('./jwt');

if (process.env.NODE_ENV === 'production') {
  console.error('mock-google-identity refuse de démarrer : NODE_ENV=production (D19, critère 6 de L0-08).');
  process.exit(1);
}

const port = process.env.PORT || 4000;
const DEFAULT_AUD = (process.env.GOOGLE_OAUTH_CLIENT_IDS || 'dev-client-id.apps.googleusercontent.com').split(',')[0];
const REAL_GOOGLE_ISS = 'https://accounts.google.com';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Cinq variantes d'invalidité distinctes (critère d'acceptation 3 de L0-08), sélectionnables
 * par le champ "invalid" du corps de /token. Les tests négatifs de L1-01 en dépendent
 * entièrement : contre le vrai Google, ils seraient impossibles à écrire.
 */
function applyInvalidVariant(claims, signingKeyRef, variant) {
  switch (variant) {
    case 'aud':
      return { claims: { ...claims, aud: 'wrong-client-id.apps.googleusercontent.com' }, signingKeyRef };
    case 'exp':
      return { claims: { ...claims, exp: Math.floor(Date.now() / 1000) - 3600 }, signingKeyRef };
    case 'email_verified':
      return { claims: { ...claims, email_verified: false }, signingKeyRef };
    case 'signature':
      return { claims, signingKeyRef: rogue };
    case 'iss':
      return { claims: { ...claims, iss: 'https://evil.example.invalid' }, signingKeyRef };
    case undefined:
    case null:
      return { claims, signingKeyRef };
    default:
      throw new Error(
        `variante "invalid" inconnue : ${variant} (attendu : aud, exp, email_verified, signature, iss)`
      );
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/rt/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jwks()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'corps JSON invalide' }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const baseClaims = {
      sub: body.sub ?? `mock-user-${crypto.randomUUID()}`,
      email: body.email ?? 'mock.user@example.invalid',
      email_verified: body.email_verified ?? true,
      aud: body.aud ?? DEFAULT_AUD,
      iss: body.iss ?? REAL_GOOGLE_ISS,
      iat: now,
      exp: body.exp ?? now + 3600,
    };

    let result;
    try {
      result = applyInvalidVariant(baseClaims, primary, body.invalid);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    // Un champ explicite du corps de la requête l'emporte toujours sur la variante nommée --
    // "l'appelant fournit sub, email, email_verified, aud, iss, exp" (spécification, au pied de
    // la lettre), la variante "invalid" n'est qu'un raccourci pour les cas les plus fréquents.
    const claims = { ...result.claims };
    for (const key of ['sub', 'email', 'email_verified', 'aud', 'iss', 'exp']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) claims[key] = body[key];
    }

    const idToken = signRS256(claims, result.signingKeyRef.privateKey, result.signingKeyRef.kid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id_token: idToken, claims }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, () => {
  console.log(`mock-google-identity à l'écoute sur le port ${port} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});
