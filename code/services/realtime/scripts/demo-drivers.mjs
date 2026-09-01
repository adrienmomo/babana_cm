// Compagnon de `make seed` (`make seed-drivers`) : tient les chauffeurs de démonstration EN
// LIGNE et EN MOUVEMENT dans Douala, pour l'étape 1 du scénario de `amoa/07-demonstration.md`
// (« cinq chauffeurs autour de lui — réels, tenus à jour en direct »).
//
// Pourquoi un script séparé du seed Odoo : le pool géo-indexé du service temps réel n'a qu'un
// seul écrivain — le script Lua d'éligibilité (D26) — alimenté uniquement par des
// `position.update` reçus sur une connexion WebSocket chauffeur authentifiée. Aucun jeu de
// données Odoo ne peut y écrire. Ce script fait donc EXACTEMENT ce que fait l'application
// Chauffeur : il s'authentifie par le vrai `/auth/google` (via mock-google-identity), ouvre une
// connexion WebSocket, envoie `availability.set` puis des `position.update` réguliers. Aucun
// raccourci serveur, aucune écriture Redis directe.
//
// Les déplacements sont **plausibles, pas aléatoires** (D21) : chaque chauffeur suit un
// itinéraire fixe tracé le long de rues de la rive est de Douala (Akwa, Bonapriso, Deïdo,
// New-Bell, Bépanda), à une vitesse de moto constante. Aucun `Math.random()` : la flotte est
// reproductible d'une exécution à l'autre. Aucun itinéraire n'approche le Wouri — une moto suit
// des rues, elle ne traverse pas le fleuve.
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
//   BABANA_DEMO_ORIGIN          4.0483,9.6934      (Akwa — centre autour duquel les itinéraires
//                                                  sont tracés ; les décaler décale la flotte)
//   BABANA_DEMO_PING_SECONDS    15                 (< POSITION_TTL_SECONDS du service, 60)
//   BABANA_DEMO_SPEED_KMH       22                 (vitesse de croisière d'une moto en ville)

import { randomUUID } from 'node:crypto';

const IDENTITY_TOKEN_URL = process.env.BABANA_IDENTITY_TOKEN_URL || 'http://localhost:4000/token';
const API_URL = (process.env.BABANA_API_URL || 'http://localhost:8069').replace(/\/$/, '');
const WS_URL = process.env.BABANA_REALTIME_WS_URL || 'ws://localhost:3000/rt/ws';
const COUNT = Number(process.env.BABANA_DEMO_DRIVER_COUNT || 5);
const PING_SECONDS = Number(process.env.BABANA_DEMO_PING_SECONDS || 15);
const SPEED_MPS = (Number(process.env.BABANA_DEMO_SPEED_KMH || 22) * 1000) / 3600;
const [ORIGIN_LAT, ORIGIN_LNG] = (process.env.BABANA_DEMO_ORIGIN || '4.0483,9.6934')
  .split(',')
  .map(Number);

// Mètres par degré autour de Douala (~4° N) : la latitude est quasi constante, la longitude est
// réduite par cos(latitude). Suffit pour interpoler des positions sur des segments courts.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

// Itinéraires, en décalages (dLat, dLng) par rapport à BABANA_DEMO_ORIGIN — comme l'étaient les
// positions fixes de la version précédente, mais reliées en tracés. Chaque tracé suit
// grossièrement une trame de rues (segments cardinaux, virages aux carrefours). Les tracés dont
// le dernier point rejoint le premier sont parcourus en boucle ; les autres en aller-retour.
// Tous restent à l'est du Wouri (dLng >= -0.005 => longitude >= ~9.688).
const ROUTES = [
  {
    label: 'Akwa — boucle Boulevard de la Liberté / Rue Joss',
    points: [
      [0.0, -0.003], [0.0016, -0.003], [0.0032, -0.0028], [0.004, -0.001],
      [0.0042, 0.0012], [0.0028, 0.0026], [0.001, 0.0024], [-0.0004, 0.001],
      [-0.0006, -0.0012], [0.0, -0.003],
    ],
  },
  {
    label: 'Akwa → Deïdo — axe Boulevard de la République (aller-retour)',
    points: [
      [0.001, 0.0006], [0.0055, 0.0018], [0.01, 0.003], [0.014, 0.0056],
      [0.0175, 0.009], [0.0205, 0.0116],
    ],
  },
  {
    label: 'Akwa → New-Bell — Rue de la Chapelle (aller-retour)',
    points: [
      [0.0006, 0.001], [0.0018, 0.006], [0.003, 0.011], [0.0044, 0.016], [0.005, 0.021],
    ],
  },
  {
    label: 'Bonapriso — boucle résidentielle sud',
    points: [
      [-0.018, 0.009], [-0.02, 0.011], [-0.021, 0.0136], [-0.0195, 0.0158],
      [-0.017, 0.015], [-0.0158, 0.0122], [-0.0165, 0.0096], [-0.018, 0.009],
    ],
  },
  {
    label: 'Bali / Akwa ouest — boucle courte',
    points: [
      [-0.0026, -0.003], [-0.001, -0.0044], [0.001, -0.004], [0.0022, -0.0018],
      [0.0014, 0.0004], [-0.0006, 0.0], [-0.002, -0.0016], [-0.0026, -0.003],
    ],
  },
  {
    label: 'Akwa nord → Bessengué → Bépanda (aller-retour)',
    points: [
      [0.0035, 0.002], [0.0075, 0.005], [0.0115, 0.0085], [0.015, 0.0125],
      [0.018, 0.017], [0.0205, 0.0215],
    ],
  },
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

/** Segment `[lat, lng]` en mètres relatifs, pour mesurer et interpoler. */
function toMeters([lat, lng]) {
  return [lat * M_PER_DEG_LAT, lng * M_PER_DEG_LNG];
}

/** Un itinéraire prêt à parcourir : points absolus, longueurs cumulées, bouclé ou non. */
function buildItinerary(route) {
  const points = route.points.map(([dLat, dLng]) => [ORIGIN_LAT + dLat, ORIGIN_LNG + dLng]);
  const segments = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = toMeters(points[i]);
    const [bx, by] = toMeters(points[i + 1]);
    const length = Math.hypot(bx - ax, by - ay);
    segments.push({ from: points[i], to: points[i + 1], start: total, length });
    total += length;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const closed =
    Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
  return { label: route.label, segments, total, closed };
}

/** Position et cap à la distance `progress` (mètres) du début de l'itinéraire. */
function locate(itinerary, progress, direction) {
  const clamped = Math.max(0, Math.min(progress, itinerary.total));
  let seg = itinerary.segments[0];
  for (const candidate of itinerary.segments) {
    if (clamped >= candidate.start) seg = candidate;
    else break;
  }
  const along = seg.length > 0 ? (clamped - seg.start) / seg.length : 0;
  const lat = seg.from[0] + (seg.to[0] - seg.from[0]) * along;
  const lng = seg.from[1] + (seg.to[1] - seg.from[1]) * along;
  const dLatM = (seg.to[0] - seg.from[0]) * M_PER_DEG_LAT * direction;
  const dLngM = (seg.to[1] - seg.from[1]) * M_PER_DEG_LNG * direction;
  const heading = (Math.atan2(dLngM, dLatM) * 180) / Math.PI;
  return { lat, lng, heading: (heading + 360) % 360 };
}

class DemoDriver {
  constructor(index) {
    this.index = index;
    this.itinerary = buildItinerary(ROUTES[(index - 1) % ROUTES.length]);
    // Départ étalé sur l'itinéraire, déterministe : deux chauffeurs sur le même tracé ne se
    // superposent pas.
    this.progress = ((((index - 1) * 0.37) % 1) + 1) % 1 * this.itinerary.total;
    this.direction = 1;
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
      console.log(`  chauffeur ${this.index} en ligne — ${this.itinerary.label}`);
      ws.send(envelope('availability.set', { online: true }));
      this.sendPosition();
      this.timer = setInterval(() => this.tick(), PING_SECONDS * 1000);
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

  /** Avance sur l'itinéraire puis émet la nouvelle position. */
  tick() {
    const step = SPEED_MPS * PING_SECONDS;
    this.progress += step * this.direction;
    if (this.itinerary.closed) {
      // Boucle continue : on repart au début sans faire demi-tour.
      this.progress = ((this.progress % this.itinerary.total) + this.itinerary.total) % this.itinerary.total;
    } else if (this.progress >= this.itinerary.total) {
      this.progress = this.itinerary.total;
      this.direction = -1;
    } else if (this.progress <= 0) {
      this.progress = 0;
      this.direction = 1;
    }
    this.sendPosition();
  }

  sendPosition() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const { lat, lng, heading } = locate(this.itinerary, this.progress, this.direction);
    this.ws.send(
      envelope('position.update', {
        latitude: lat,
        longitude: lng,
        accuracyMeters: 12,
        speedMetersPerSecond: Math.round(SPEED_MPS * 10) / 10,
        headingDegrees: Math.round(heading),
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
    `make seed-drivers : ${COUNT} chauffeur(s) en mouvement autour de ${ORIGIN_LAT},${ORIGIN_LNG}\n` +
      `  identité  ${IDENTITY_TOKEN_URL}\n  API       ${API_URL}\n  WebSocket ${WS_URL}\n` +
      `  vitesse   ${(SPEED_MPS * 3.6).toFixed(0)} km/h, position toutes les ${PING_SECONDS} s\n`,
  );
  const drivers = [];
  for (let i = 1; i <= COUNT; i += 1) {
    const driver = new DemoDriver(i);
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
