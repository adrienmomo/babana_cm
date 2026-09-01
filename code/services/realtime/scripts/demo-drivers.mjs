// Compagnon de `make seed` (`make seed-drivers`) : tient les chauffeurs de démonstration EN
// LIGNE sur la carte, à des positions dispersées dans Douala, pour l'étape 1 du scénario de
// `amoa/07-demonstration.md` (« cinq chauffeurs autour de lui — réels, tenus à jour en direct »).
//
// Pourquoi un script séparé du seed Odoo : le pool géo-indexé du service temps réel n'a qu'un
// seul écrivain — le script Lua d'éligibilité (D26) — alimenté uniquement par des
// `position.update` reçus sur une connexion WebSocket chauffeur authentifiée. Aucun jeu de
// données Odoo ne peut y écrire. Ce script fait donc EXACTEMENT ce que fait l'application
// Chauffeur : il s'authentifie par le vrai `/auth/google` (via mock-google-identity), ouvre une
// connexion WebSocket, envoie `availability.set` puis des `position.update` réguliers. Aucun
// raccourci serveur, aucune écriture Redis directe.
//
// Contrat avec `services/odoo/scripts/seed.py` : les chauffeurs de démonstration ont pour
// `google_sub` `babana-demo-driver-1` .. `babana-demo-driver-<N>`. C'est la seule chose que les
// deux fichiers doivent garder d'accord (N = BABANA_DEMO_DRIVER_COUNT, 5 par défaut).
//
// Sans dépendance : `fetch`, `WebSocket` et `crypto.randomUUID` sont natifs dès Node 22.
//
// Usage :  make seed-drivers            (Ctrl-C pour arrêter — repasse chacun hors ligne)
// Réglages par variables d'environnement (valeurs de développement par défaut) :
//   BABANA_IDENTITY_TOKEN_URL   http://localhost:4000/token
//   BABANA_API_URL              http://localhost:8069
//   BABANA_REALTIME_WS_URL      ws://localhost:3000/rt/ws
//   BABANA_DEMO_DRIVER_COUNT    5
//   BABANA_DEMO_ORIGIN          4.0483,9.6934      (centre du nuage de positions — Akwa)
//   BABANA_DEMO_PING_SECONDS    15                 (< POSITION_TTL_SECONDS du service, 60)

import { randomUUID } from 'node:crypto';

const IDENTITY_TOKEN_URL = process.env.BABANA_IDENTITY_TOKEN_URL || 'http://localhost:4000/token';
const API_URL = (process.env.BABANA_API_URL || 'http://localhost:8069').replace(/\/$/, '');
const WS_URL = process.env.BABANA_REALTIME_WS_URL || 'ws://localhost:3000/rt/ws';
const COUNT = Number(process.env.BABANA_DEMO_DRIVER_COUNT || 5);
const PING_SECONDS = Number(process.env.BABANA_DEMO_PING_SECONDS || 15);
const [ORIGIN_LAT, ORIGIN_LNG] = (process.env.BABANA_DEMO_ORIGIN || '4.0483,9.6934')
  .split(',')
  .map(Number);

// Décalages fixes autour de l'origine (~0,3 à 1,6 km), pas aléatoires (D21) : une flotte
// reproductible d'une exécution à l'autre.
const OFFSETS = [
  { dLat: +0.0032, dLng: +0.0041, label: 'Akwa nord' },
  { dLat: -0.0028, dLng: -0.0029, label: 'Bali / Akwa ouest' },
  { dLat: +0.0091, dLng: +0.0076, label: 'axe Deïdo' },
  { dLat: +0.0017, dLng: +0.0146, label: 'New-Bell ouest' },
  { dLat: -0.0053, dLng: +0.0026, label: 'Bonapriso nord' },
  { dLat: +0.0064, dLng: -0.0043, label: 'Bonanjo' },
  { dLat: -0.0089, dLng: -0.0071, label: 'Bonapriso sud' },
  { dLat: +0.0122, dLng: -0.0102, label: 'Bonabéri' },
];

function envelope(type, payload) {
  return JSON.stringify({ type, id: randomUUID(), emittedAt: new Date().toISOString(), payload });
}

async function issueDriverToken(index) {
  const sub = `babana-demo-driver-${index}`;
  const tokenRes = await fetch(IDENTITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sub,
      email: `${sub}@drivers.example.cm`,
      email_verified: true,
      name: `Chauffeur démo ${index}`,
    }),
  });
  if (!tokenRes.ok) throw new Error(`mock-google-identity /token → HTTP ${tokenRes.status}`);
  const { id_token: idToken } = await tokenRes.json();

  const authRes = await fetch(`${API_URL}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, role: 'driver' }),
  });
  const body = await authRes.json();
  if (!authRes.ok) {
    throw new Error(`/api/v1/auth/google → HTTP ${authRes.status} ${JSON.stringify(body)}`);
  }
  if (body.user?.driverStatus && body.user.driverStatus !== 'approved') {
    throw new Error(
      `chauffeur ${sub} au statut "${body.user.driverStatus}" — lancer \`make seed\` d'abord`,
    );
  }
  return body.accessToken;
}

function jitter() {
  // ±~25 m, pour que la position « bouge » légèrement sans quitter le quartier.
  return (Math.random() - 0.5) * 0.0004;
}

class DemoDriver {
  constructor(index, offset) {
    this.index = index;
    this.offset = offset;
    this.lat = ORIGIN_LAT + offset.dLat;
    this.lng = ORIGIN_LNG + offset.dLng;
    this.ws = null;
    this.timer = null;
    this.stopped = false;
  }

  async start() {
    const token = await issueDriverToken(this.index);
    this.connect(token);
  }

  connect(token) {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log(`  chauffeur ${this.index} en ligne — ${this.offset.label}`);
      ws.send(envelope('availability.set', { online: true }));
      this.sendPosition();
      this.timer = setInterval(() => this.sendPosition(), PING_SECONDS * 1000);
    });

    ws.addEventListener('close', (ev) => {
      clearInterval(this.timer);
      if (this.stopped) return;
      console.warn(`  chauffeur ${this.index} déconnecté (code ${ev.code}) — nouvelle tentative dans 3 s`);
      setTimeout(() => this.start().catch((e) => console.error(`  chauffeur ${this.index} :`, e.message)), 3000);
    });

    ws.addEventListener('error', () => {
      /* 'close' suit toujours 'error' — la reconnexion est gérée là. */
    });
  }

  sendPosition() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      envelope('position.update', {
        latitude: this.lat + jitter(),
        longitude: this.lng + jitter(),
        accuracyMeters: 12,
        speedMetersPerSecond: null,
        headingDegrees: null,
        precedingSamples: [],
      }),
    );
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(envelope('availability.set', { online: false }));
      } catch {
        /* rien — on ferme de toute façon */
      }
      this.ws.close();
    }
  }
}

async function main() {
  console.log(
    `make seed-drivers : ${COUNT} chauffeur(s) autour de ${ORIGIN_LAT},${ORIGIN_LNG}\n` +
      `  identité  ${IDENTITY_TOKEN_URL}\n  API       ${API_URL}\n  WebSocket ${WS_URL}\n`,
  );
  const drivers = [];
  for (let i = 1; i <= COUNT; i += 1) {
    const offset = OFFSETS[(i - 1) % OFFSETS.length];
    const driver = new DemoDriver(i, offset);
    drivers.push(driver);
    try {
      await driver.start();
    } catch (err) {
      console.error(`  chauffeur ${i} : ${err.message}`);
    }
  }

  const shutdown = () => {
    console.log('\narrêt — repasse les chauffeurs hors ligne…');
    drivers.forEach((d) => d.stop());
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('\nen ligne. Ctrl-C pour arrêter.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
