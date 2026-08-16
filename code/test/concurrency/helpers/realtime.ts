// Amène un chauffeur réellement en ligne, positionné, et visible d'un client (L3-17) -- par le
// chemin réel (WebSocket, L3-01/L3-02/L3-04/L3-05), jamais par une écriture Redis directe qui
// contournerait ce que ce câblage est censé prouver. Même principe que
// services/odoo/addons/babana/tests/_realtime_ws.py côté Python -- ici en TypeScript, où un vrai
// client WebSocket (`ws`, déjà une dépendance de @babana/realtime) est le choix naturel plutôt
// qu'une réimplémentation manuelle du protocole.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import Redis from 'ioredis';

const REALTIME_WS_URL = (process.env.REALTIME_WS_URL ?? 'ws://localhost:3000') + '/rt/ws';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function envelope(type: string, payload: unknown) {
  return { type, id: randomUUID(), emittedAt: new Date().toISOString(), payload };
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Fait passer un chauffeur en ligne et émettre une position -- L3-01 (authentification), L3-02
 * (ingestion), L3-04 (bascule en ligne). Le jeton est le même accessToken que l'API REST (D23,
 * même claims).
 *
 * **Renvoie la connexion, laissée OUVERTE** : la fermer déclencherait la période de grâce de
 * déconnexion (L3-04, critère 3, `AVAILABILITY_DISCONNECT_GRACE_SECONDS`, 45 s par défaut) --
 * sans conséquence pour un test isolé et rapide, mais ce fichier réutilise le même chauffeur sur
 * plusieurs dizaines d'itérations (scénario 1) dont la durée cumulée peut approcher ce délai. Un
 * vrai chauffeur reste connecté ; ce test doit en faire autant. L'appelant ferme la connexion à
 * la fin du test (voir `setUpActors`/`after`).
 */
// Nettement sous POSITION_TTL_SECONDS (60 s par défaut) : une position expirée retire le
// chauffeur du pool (L3-02), et rien d'autre dans ces tests ne l'y remettrait avant la position
// suivante -- exactement ce qu'un vrai chauffeur évite en continuant d'émettre.
const POSITION_REFRESH_INTERVAL_MS = 20_000;

function sendPosition(ws: WebSocket, position: LatLng): void {
  ws.send(
    JSON.stringify(
      envelope('position.update', {
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyMeters: 10,
        speedMetersPerSecond: 0,
        headingDegrees: 0,
      })
    )
  );
}

export async function bringDriverOnline(driverToken: string, position: LatLng): Promise<WebSocket> {
  const ws = new WebSocket(`${REALTIME_WS_URL}?token=${driverToken}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify(envelope('availability.set', { online: true })));
  sendPosition(ws, position);

  // Un vrai chauffeur continue d'émettre sa position pendant toute la durée de la connexion --
  // un scénario de test qui réutilise ce même chauffeur sur plusieurs dizaines de secondes doit
  // en faire autant, sous peine de le voir expirer du pool (L3-02) au milieu du test.
  const refresh = setInterval(() => {
    if (ws.readyState === ws.OPEN) sendPosition(ws, position);
  }, POSITION_REFRESH_INTERVAL_MS);
  refresh.unref();
  ws.on('close', () => clearInterval(refresh));

  // Laisse le serveur traiter les deux premiers messages (non attendus par son propre
  // gestionnaire, ws/connection.ts) avant de continuer.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return ws;
}

/**
 * Bascule explicitement hors ligne puis ferme la connexion -- retrait IMMÉDIAT et inconditionnel
 * du pool (L3-04), par opposition à une simple fermeture de socket qui déclenche seulement la
 * période de grâce de déconnexion (45 s par défaut, critère 3 de L3-04). Un vrai chauffeur qui
 * termine sa session appuie sur "hors ligne" ; un test qui enchaîne beaucoup d'itérations doit en
 * faire autant, sous peine d'accumuler des chauffeurs fantômes dans le pool pendant 45 s après
 * chaque itération -- au même point géographique que les suivants, ils finissent par déborder la
 * limite des 5 plus proches (D14) et masquer les chauffeurs que l'itération courante vient de
 * poser.
 */
export async function takeDriverOffline(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(envelope('availability.set', { online: false })));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  ws.close();
}

/**
 * Ouvre un abonnement `nearby.subscribe` et le laisse actif -- la diffusion périodique du serveur
 * (`NEARBY_BROADCAST_INTERVAL_SECONDS`, 5 s par défaut) rafraîchit alors en continu la dernière
 * liste envoyée à ce client (`nearby/last-sent.ts`, TTL `NEARBY_LAST_SENT_TTL_SECONDS`, 30 s par
 * défaut) -- indispensable pour un scénario qui sélectionne le même chauffeur à de nombreuses
 * reprises sur une durée qui peut dépasser ce TTL (voir ride-transitions.test.ts, scénario 1).
 * L'appelant ferme la connexion renvoyée en fin de test.
 */
export async function openClientSubscription(
  clientToken: string,
  position: LatLng,
  radiusMeters = 5_000
): Promise<WebSocket> {
  const ws = new WebSocket(`${REALTIME_WS_URL}?token=${clientToken}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify(envelope('nearby.subscribe', { position, radiusMeters })));
  return ws;
}

// Largement au-dessus de NEARBY_BROADCAST_INTERVAL_SECONDS (5 s par défaut) : quelques périodes
// de marge pour un environnement de test chargé, sans jamais re-solliciter `nearby.subscribe`.
const DEFAULT_VISIBILITY_WAIT_MS = 20_000;

/**
 * Attend que TOUS les chauffeurs visés apparaissent dans `nearby.drivers` sur une connexion
 * client déjà abonnée (`openClientSubscription`) -- c'est cette réception qui pose la
 * précondition C-03 côté serveur (`nearby/last-sent.ts`, L3-17, critère 8), pas un raccourci de
 * test.
 *
 * **Purement passif** : écoute les diffusions périodiques déjà en cours (L3-05,
 * `NEARBY_BROADCAST_INTERVAL_SECONDS`), n'envoie plus jamais son propre `nearby.subscribe`. Une
 * première version ré-abonnait à chaque tentative pour forcer une diffusion immédiate -- plus
 * rapide, mais chaque ré-abonnement compte dans la limitation de débit (L3-05, critère 6,
 * `NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS`, 10 par fenêtre de 60 s par défaut) : un scénario à
 * plusieurs itérations qui vérifie la visibilité de plusieurs chauffeurs à chaque itération
 * épuisait ce quota bien avant d'avoir prouvé quoi que ce soit -- constaté en pratique
 * (select-driver-replay.test.ts). La diffusion périodique déjà active suffit, sans jamais
 * remettre le compteur de débit à contribution.
 */
export async function waitForDriverVisible(
  socket: WebSocket,
  driverPublicIds: string | string[],
  _position: LatLng,
  options: { maxWaitMs?: number } = {}
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_VISIBILITY_WAIT_MS;
  const remaining = new Set(Array.isArray(driverPublicIds) ? driverPublicIds : [driverPublicIds]);

  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== 'nearby.drivers') return;
        const drivers = message.payload?.drivers ?? [];
        for (const d of drivers as { driverId: string }[]) remaining.delete(d.driverId);
        if (remaining.size === 0) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve();
        }
      } catch {
        // message illisible -- ignoré, comme le ferait un vrai client (C-02)
      }
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(
        new Error(
          `chauffeur(s) [${[...remaining].join(', ')}] jamais apparu(s) dans nearby.drivers après ${maxWaitMs}ms`
        )
      );
    }, maxWaitMs);
    socket.on('message', onMessage);
  });
}

/**
 * Seede le profil chauffeur en cache (L3-05/L3-16, champ-pont documenté --
 * amoa/questions/L3-05.md, code/docs/bridge-fields.md) : nearby.drivers omet TOUJOURS un
 * chauffeur sans profil, et aucun canal Odoo -> temps réel ne le peuple encore en production
 * (L3-16 jamais implémentée). Seedé directement, comme test/nearby.test.ts le fait déjà côté
 * @babana/realtime.
 */
export async function seedDriverProfile(driverPublicId: string, firstName: string): Promise<void> {
  const redis = new Redis(REDIS_URL);
  try {
    await redis.set(
      `babana:driver:profile:${driverPublicId}`,
      JSON.stringify({ firstName, photoUrl: null, rating: 4.5, motorcycleClass: 'standard' })
    );
  } finally {
    redis.disconnect();
  }
}

export interface SelectableDriver {
  driverSocket: WebSocket;
  clientSockets: WebSocket[];
}

/**
 * Combine les étapes ci-dessus -- le cas d'usage courant d'une fixture de test. Renvoie TOUTES
 * les connexions ouvertes (chauffeur, un abonnement persistant par client), à fermer par
 * l'appelant en fin de test.
 */
export async function makeDriverSelectable(
  driverToken: string,
  driverPublicId: string,
  position: LatLng,
  clientTokens: string[]
): Promise<SelectableDriver> {
  const driverSocket = await bringDriverOnline(driverToken, position);
  await seedDriverProfile(driverPublicId, `Chauffeur ${driverPublicId.slice(0, 8)}`);

  const clientSockets: WebSocket[] = [];
  for (const clientToken of clientTokens) {
    const clientSocket = await openClientSubscription(clientToken, position);
    await waitForDriverVisible(clientSocket, driverPublicId, position);
    clientSockets.push(clientSocket);
  }
  return { driverSocket, clientSockets };
}
