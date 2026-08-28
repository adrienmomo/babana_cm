// Contre un Redis réel, comme test/geo-index.test.ts -- NearbyManager s'appuie sur findNearby
// (GEOADD/GEOSEARCH), qu'une imitation en mémoire reproduirait mal.
//
// Identifiants suffixés par un identifiant de run unique, même raison que geo-index.test.ts :
// plusieurs fichiers de ce paquet touchent la clé de production partagée
// `babana:drivers:available` en parallèle. Chaque test de ce fichier utilise en plus ses propres
// coordonnées, isolées les unes des autres (>5 km d'écart, largement au-delà de tout rayon
// interrogé ici) : les tests de ce fichier tournent dans le même processus, sans purge entre eux,
// et un chauffeur laissé par un test antérieur ne doit jamais fausser le compte exact attendu par
// un autre (même précaution que geo-index.test.ts, critère 5).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { NearbyManager } from '../src/nearby/handler';
import { projectNearbyDrivers } from '../src/nearby/projection';
import { removeFromPool } from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';
import { setDriverProfile, removeDriverProfile, type DriverProfile } from '../src/redis/driver-profiles';
import { setOffline } from '../src/driver/availability';
import { parseConfig, type Config } from '../src/config';
import type { ConnectionContext } from '../src/ws/auth';
import { putInPool } from './helpers/pool';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const BASE_ENV = {
  REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo:8069',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
};

const PROFILE: DriverProfile = {
  firstName: 'Paul',
  photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
  rating: 4.8,
  motorcycleClass: 'standard',
  licensePlate: 'LT-1234-BC',
  phoneNumber: '+237655000111',
};

const NEARBY_DRIVER_WHITELIST = ['driverId', 'firstName', 'photoUrl', 'rating', 'motorcycleClass', 'position', 'distanceMeters'].sort();

let redis: Redis;
const usedIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      setOffline(redis, driverId), // efface aussi le drapeau "en ligne" posé par putInPool
      removeFromPool(redis, driverId),
      removeDriverProfile(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function freshDriver(
  label: string,
  position: { latitude: number; longitude: number },
  profile: DriverProfile = PROFILE
): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 5, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await putInPool(redis,driverId, position.latitude, position.longitude);
  await setDriverProfile(redis, driverId, profile);
  return driverId;
}

function clientContext(label: string): ConnectionContext {
  return Object.freeze({ userId: id(label), role: 'client', driverId: null });
}

type FakeMessage =
  | { type: 'nearby.subscribe.ack'; payload: { accepted: true; broadcastIntervalMs: number } | { accepted: false; retryAfterMs: number } }
  | { type: 'nearby.drivers'; payload: { drivers: { driverId: string }[] } };

/** Faux WebSocket : NearbyManager ne lit que `readyState`/`OPEN` et écrit via `send`, aucune
 * connexion réseau réelle n'est nécessaire pour ces tests. */
function fakeSocket() {
  const messages: FakeMessage[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  return { socket: socket as unknown as WebSocket, messages };
}

// Chaque abonnement produit désormais un accusé de réception (23 août, doute L6-06 §3) avant, le
// cas échéant, la liste de chauffeurs elle-même -- ce filtre isole les seconds pour les tests
// écrits avant ce changement, qui ne portaient que sur le contenu des listes.
function driverListMessages(messages: FakeMessage[]) {
  return messages.filter((m): m is Extract<FakeMessage, { type: 'nearby.drivers' }> => m.type === 'nearby.drivers');
}

function ackMessages(messages: FakeMessage[]) {
  return messages.filter((m): m is Extract<FakeMessage, { type: 'nearby.subscribe.ack' }> => m.type === 'nearby.subscribe.ack');
}

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

// ODOO_INTERNAL_URL (BASE_ENV) ne résout jamais depuis ce processus de test (nom d'hôte Docker,
// `odoo`) : tout appel de secours vers `getDriverProfiles` (redis/driver-profiles.ts, L3-16)
// échoue donc et laisse le cache tel quel -- exactement le comportement attendu du critère 2
// (Odoo injoignable), déjà exercé par ces tests sans configuration Odoo dédiée.
const config = configWith();

describe('projectNearbyDrivers (L3-05, L3-16)', () => {
  test('critère 3 -- les positions renvoyées sont arrondies', async () => {
    const origin = { latitude: 4.12, longitude: 9.62 };
    const rawPosition = { latitude: 4.120123456, longitude: 9.620123456 };
    const driverId = await freshDriver('c3-driver', rawPosition);

    const results = await projectNearbyDrivers(config, redis, origin, 3_000, 5);
    const found = results.find((r) => r.driverId === driverId);
    assert.ok(found, 'le chauffeur doit apparaître');
    assert.notEqual(found!.position.latitude, rawPosition.latitude, 'la position brute ne doit jamais être renvoyée telle quelle');
    assert.equal(found!.position.latitude, 4.1201);
    assert.equal(found!.position.longitude, 9.6201);
  });

  test('critère 4 -- la charge utile ne contient aucun champ hors liste blanche (nom complet, téléphone, immatriculation absents)', async () => {
    const origin = { latitude: 4.0, longitude: 9.7 };
    const driverId = await freshDriver('c4-driver', origin);

    const results = await projectNearbyDrivers(config, redis, origin, 3_000, 5);
    const found = results.find((r) => r.driverId === driverId);
    assert.ok(found);
    assert.deepEqual(Object.keys(found!).sort(), NEARBY_DRIVER_WHITELIST);
    for (const forbidden of ['lastName', 'fullName', 'phone', 'phoneNumber', 'licensePlate', 'email']) {
      assert.equal(Object.prototype.hasOwnProperty.call(found, forbidden), false, `${forbidden} ne doit jamais être présent`);
    }
  });

  // D30 (amoa/questions/REPONSES-2026-08-18.md §2) : l'ancienne règle ("omis") a produit un
  // blocage total en production -- aucun chauffeur réel ne portait de profil en cache, donc
  // aucune liste, donc aucune course possible. Un défaut de cache ne retire plus jamais un
  // chauffeur de la flotte ; seule l'absence de position (donc de distance) l'écarte.
  test('un chauffeur disponible sans profil en cache reste présent, champs de profil à null (D30)', async () => {
    const origin = { latitude: 4.06, longitude: 9.7 };
    const driverId = id('c-no-profile');
    usedIds.add(driverId);
    await storePosition(
      redis,
      driverId,
      { ...origin, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
      60
    );
    await putInPool(redis,driverId, origin.latitude, origin.longitude);
    // Pas de setDriverProfile ici, délibérément -- et pas d'Odoo réel joignable à
    // ODOO_INTERNAL_URL pour cette configuration (config() ci-dessous), donc pas de source pour
    // ce chauffeur : le cas exact que D30 couvre.

    const results = await projectNearbyDrivers(config, redis, origin, 3_000, 5);
    const found = results.find((r) => r.driverId === driverId);
    assert.ok(found, 'un chauffeur sans profil reste dans la liste, jamais omis');
    assert.equal(found!.firstName, null);
    assert.equal(found!.photoUrl, null);
    assert.equal(found!.rating, null);
    assert.equal(found!.motorcycleClass, null);
  });

  test("exactement 5 résultats renvoyés, les plus proches, même avec des positions expirées en masse (critère 2, en dur -- projection = géo-index + profil)", async () => {
    const origin = { latitude: 4.0, longitude: 9.62 };
    const staleIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const driverId = id(`c2-stale-${i}`);
      usedIds.add(driverId);
      staleIds.push(driverId);
      await putInPool(redis,driverId, origin.latitude, origin.longitude + i * 0.00005);
      await setDriverProfile(redis, driverId, PROFILE);
    }
    const freshIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      freshIds.push(await freshDriver(`c2-fresh-${i}`, { latitude: origin.latitude, longitude: origin.longitude + 0.01 + i * 0.0002 }));
    }

    const results = await projectNearbyDrivers(config, redis, origin, 3_000, 5);
    assert.equal(results.length, 5, `attendu 5, obtenu ${results.length}`);
    assert.deepEqual(
      results.map((r) => r.driverId),
      freshIds.slice(0, 5)
    );

    for (const driverId of staleIds) await removeFromPool(redis, driverId);
  });
});

describe('NearbyManager (L3-05, D14)', () => {
  test('critère 1 -- un rayon demandé supérieur au plafond est ramené au plafond, sans erreur', async () => {
    const origin = { latitude: 4.12, longitude: 9.7 };
    const config = configWith({ NEARBY_MAX_RADIUS_METERS: '500' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c1-client');
    const { socket, messages } = fakeSocket();

    // ~1.1 km du centre : au-delà du plafond de 500 m, mais dans le rayon demandé (40 km).
    const farDriverId = await freshDriver('c1-far', { latitude: origin.latitude, longitude: origin.longitude + 0.01 });

    await assert.doesNotReject(() => manager.subscribe(context, socket, { position: origin, radiusMeters: 40_000, excludeDriverIds: [] }));
    manager.unsubscribe(context);

    assert.equal(messages.length, 2, 'accusé de réception puis liste de chauffeurs');
    assert.equal(messages[0]!.type, 'nearby.subscribe.ack');
    // D50 : l'accusé accepté porte la cadence réelle de la diffusion (NEARBY_BROADCAST_INTERVAL_SECONDS).
    const ack = messages[0]!;
    assert.ok(ack.type === 'nearby.subscribe.ack' && ack.payload.accepted && ack.payload.broadcastIntervalMs === config.NEARBY_BROADCAST_INTERVAL_SECONDS * 1000);
    const [driversMessage] = driverListMessages(messages);
    assert.equal(
      driversMessage!.payload.drivers.some((d) => d.driverId === farDriverId),
      false,
      'exclu malgré le rayon demandé : au-delà du plafond configuré côté service'
    );
  });

  test('critère 5 -- un second abonnement du même client remplace le premier', async () => {
    const origin = { latitude: 4.12, longitude: 9.78 };
    const otherOrigin = { latitude: 4.06, longitude: 9.78 };
    const config = configWith({ NEARBY_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c5-client');
    const { socket, messages } = fakeSocket();

    const driverNearOrigin = await freshDriver('c5-driver-origin', origin);
    const driverNearOther = await freshDriver('c5-driver-other', otherOrigin);

    await manager.subscribe(context, socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: [] });
    await manager.subscribe(context, socket, { position: otherOrigin, radiusMeters: 3_000, excludeDriverIds: [] });

    // Laisse un intervalle de diffusion s'écouler : si le premier abonnement n'avait pas été
    // annulé, deux minuteurs tourneraient et produiraient des messages pour les deux origines.
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.unsubscribe(context);

    const driverMessages = driverListMessages(messages);
    assert.ok(driverMessages.length >= 2, 'au moins la réponse immédiate de chaque abonnement');
    assert.ok(driverMessages[0]!.payload.drivers.some((d) => d.driverId === driverNearOrigin));
    for (const message of driverMessages.slice(1)) {
      assert.equal(
        message.payload.drivers.some((d) => d.driverId === driverNearOrigin),
        false,
        'plus aucun message ne doit porter le résultat du premier abonnement, remplacé par le second'
      );
    }
    assert.ok(driverMessages.at(-1)!.payload.drivers.some((d) => d.driverId === driverNearOther));
  });

  test('critère 6 -- la limitation de débit est appliquée', async () => {
    const origin = { latitude: 4.0, longitude: 9.8 };
    const config = configWith({ NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS: '2', NEARBY_RATE_LIMIT_WINDOW_SECONDS: '60' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c6-client');

    const attempts: { messages: FakeMessage[] }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { socket, messages } = fakeSocket();
      // eslint-disable-next-line no-await-in-loop -- les abonnements doivent être séquentiels
      // pour que le compteur de débit les voie un par un, comme des appels WebSocket réels.
      await manager.subscribe(context, socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: [] });
      attempts.push({ messages });
    }
    manager.unsubscribe(context);

    const accepted = attempts.filter((a) => ackMessages(a.messages)[0]!.payload.accepted);
    assert.equal(accepted.length, 2, `seuls les 2 premiers abonnements (limite) doivent être acceptés, obtenu ${accepted.length}`);
    for (const attempt of accepted) {
      assert.equal(attempt.messages.length, 2, 'accepté : accusé de réception puis liste de chauffeurs');
      assert.equal(attempt.messages[1]!.type, 'nearby.drivers');
    }
  });

  test('critère 6 (23 août) -- un abonnement refusé produit un accusé de réception explicite, jamais un silence', async () => {
    // Doute L6-06 §3 (amoa/questions/REPONSES-2026-08-23.md §2) : avant ce test, un abonnement
    // au-delà de la limite ne produisait rien -- un client qui insistait sur "Réessayer" pouvait
    // cesser d'être servi sans qu'aucun élément ne le lui dise.
    const origin = { latitude: 4.02, longitude: 9.82 };
    const config = configWith({ NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS: '1', NEARBY_RATE_LIMIT_WINDOW_SECONDS: '60' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c6b-client');

    const first = fakeSocket();
    await manager.subscribe(context, first.socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: [] });
    const second = fakeSocket();
    await manager.subscribe(context, second.socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: [] });
    manager.unsubscribe(context);

    assert.equal(second.messages.length, 1, 'refusé : un accusé de réception seul, aucune liste de chauffeurs');
    const [ack] = ackMessages(second.messages);
    assert.ok(ack);
    assert.equal(ack.payload.accepted, false);
    assert.ok(!ack.payload.accepted && ack.payload.retryAfterMs > 0);
  });

  // L3-08 (24 août) : l'abonnement passe désormais par l'élargissement (nearby/expand.ts) dès
  // qu'un `excludeDriverIds` non vide accompagne la demande -- ce test vérifie le câblage bout en
  // bout depuis NearbyManager, pas la logique d'élargissement elle-même (déjà couverte par
  // test/expand.test.ts).
  test("critère 1/2 (L3-08) -- un abonnement avec des refusants élargit le rayon jusqu'à trouver un candidat", async () => {
    const origin = { latitude: 4.14, longitude: 9.84 };
    const config = configWith({
      NEARBY_MAX_RADIUS_METERS: '500',
      NEARBY_EXPAND_RADIUS_STEP_METERS: '1000',
      NEARBY_EXPAND_MAX_RADIUS_METERS: '3000',
    });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('l308-client');

    // ~2 000 m du centre : hors du plafond normal (500 m, même après le rayon demandé de 3 000
    // m ci-dessous, capé à 500), atteint seulement par l'élargissement (500 -> 1500 -> 2500).
    const farDriverId = await freshDriver('l308-far', { latitude: origin.latitude + 2_000 / 111_320, longitude: origin.longitude });

    const refused = fakeSocket();
    await manager.subscribe(context, refused.socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: ['someone-else-entirely'] });
    manager.unsubscribe(context);

    const [driversMessage] = driverListMessages(refused.messages);
    assert.ok(
      driversMessage!.payload.drivers.some((d) => d.driverId === farDriverId),
      "le chauffeur élargi doit apparaître -- l'exclusion d'un tiers ne doit pas empêcher l'élargissement"
    );

    // Découverte libre (sans refusant) à la même origine : le plafond normal (500 m) doit tenir,
    // le même chauffeur élargi ne doit jamais apparaître (C2b, critère 1 de L3-05, non régressé
    // par L3-08 -- voir aussi test/expand.test.ts).
    const discovery = fakeSocket();
    await manager.subscribe(context, discovery.socket, { position: origin, radiusMeters: 3_000, excludeDriverIds: [] });
    manager.unsubscribe(context);
    const [discoveryMessage] = driverListMessages(discovery.messages);
    assert.equal(
      discoveryMessage!.payload.drivers.some((d) => d.driverId === farDriverId),
      false,
      'une découverte libre ne doit jamais dépasser le plafond configuré'
    );
  });

  // L3-20 (30 août) -- cause racine du silence de diffusion (amoa/questions/
  // L3-05-nearby-list-goes-silently-empty.md) : deux `nearby.subscribe` reçus pour le même
  // client SANS attendre le premier (ce que produisait la file hors connexion côté app en
  // rejouant un abonnement périmé en même temps que l'écran en réémettait un à jour). Le test
  // "critère 5" ci-dessus attend chaque abonnement avant le suivant -- il ne peut pas voir cette
  // course. Celui-ci force délibérément l'abonnement le plus ANCIEN à répondre le plus
  // LENTEMENT (plusieurs paliers d'élargissement séquentiels, origine sans aucun chauffeur) pour
  // prouver que l'ORDRE D'APPEL, pas l'ordre de résolution, décide qui l'emporte.
  test("L3-20 -- un abonnement plus ancien dont la réponse Redis revient après un plus récent ne doit jamais lui survivre", async () => {
    const freshOrigin = { latitude: 4.09, longitude: 9.75 };
    // Coin opposé de la zone d'exploitation (config.ts, OPERATIONAL_BOUNDS_*) : aucun chauffeur
    // n'y sera jamais trouvé, quel que soit le palier.
    const staleOrigin = { latitude: 3.96, longitude: 9.61 };
    const config = configWith({
      NEARBY_BROADCAST_INTERVAL_SECONDS: '0.05',
      NEARBY_MAX_RADIUS_METERS: '2000',
      NEARBY_EXPAND_RADIUS_STEP_METERS: '500',
      NEARBY_EXPAND_MAX_RADIUS_METERS: '2500',
    });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('l320-client');
    const freshDriverId = await freshDriver('l320-driver', freshOrigin);
    const { socket, messages } = fakeSocket();

    // La demande "stale" est appelée EN PREMIER, mais porte un excludeDriverIds non vide : elle
    // emprunte nearby/expand.ts, qui essaie séquentiellement 5 paliers (500 à 2500 m) avant de
    // renvoyer une liste vide -- 5 allers-retours Redis, contre 1 seul pour la découverte libre
    // "fresh" appelée juste après. "stale" est donc garantie de répondre après "fresh", peu
    // importe la machine qui exécute ce test.
    const stalePromise = manager.subscribe(context, socket, {
      position: staleOrigin,
      radiusMeters: 500,
      excludeDriverIds: ['someone-else-entirely'],
    });
    const freshPromise = manager.subscribe(context, socket, { position: freshOrigin, radiusMeters: 3_000, excludeDriverIds: [] });
    await Promise.all([stalePromise, freshPromise]);

    // Laisse au moins un intervalle de diffusion s'écouler.
    await new Promise((resolve) => setTimeout(resolve, 150));
    manager.unsubscribe(context);
    const countAtUnsubscribe = messages.length;

    // La dernière diffusion périodique doit porter le résultat de la demande la plus récemment
    // APPELÉE (fresh), jamais celui de la demande la plus ancienne simplement parce qu'elle a
    // fini par répondre en dernier.
    const driverMessages = driverListMessages(messages);
    assert.ok(driverMessages.length >= 2, 'au moins une diffusion périodique après les deux réponses immédiates');
    assert.ok(
      driverMessages.at(-1)!.payload.drivers.some((d) => d.driverId === freshDriverId),
      'la dernière diffusion doit porter le chauffeur de la demande la plus récente, pas celui de la demande périmée'
    );

    // Et surtout : après unsubscribe(), plus AUCUN message ne doit continuer d'arriver -- un
    // minuteur orphelin (celui de la demande perdante, si elle avait quand même posé le sien)
    // continuerait sinon à interroger Redis indéfiniment pour un client qui ne l'a plus demandé.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      messages.length,
      countAtUnsubscribe,
      'aucun minuteur ne doit survivre à unsubscribe() -- ni celui de la demande périmée ni un second orphelin'
    );
  });
});
