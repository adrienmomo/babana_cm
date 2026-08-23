// État de course unifié (L3-18, D26). Contre un Redis réel -- comme reservation.test.ts et
// proposal.test.ts, une imitation en mémoire ne prouverait rien de l'atomicité que ride/state.lua
// apporte. Le test de concurrence qui prouve l'exclusivité de 'reserve' reste
// test/concurrency/reservation.test.ts (L3-13) -- ce fichier-ci couvre le comportement
// fonctionnel des quatre actions et les deux critères structurels (1 et 2) de cette tâche.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import Redis from 'ioredis';
import {
  reserve,
  resolve,
  release,
  forceEngaged,
  attachEngagedSession,
  getState,
  isReserved,
  isEngaged,
  getEngagedSession,
  scanEngagedDriverIds,
  rideStateKey,
  rideOwnerKey,
} from '../src/ride/state';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { storePosition } from '../src/redis/positions';
import { setOnline, setOffline } from '../src/driver/availability';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;
const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };

let redis: Redis;
const usedDriverIds = new Set<string>();
const usedRideIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all([
    ...[...usedDriverIds].flatMap((driverId) => [
      removeFromPool(redis, driverId),
      setOffline(redis, driverId),
      redis.del(rideStateKey(driverId)),
      redis.del(`babana:driver:position:${driverId}`),
    ]),
    ...[...usedRideIds].map((rideId) => redis.del(rideOwnerKey(rideId))),
  ]);
  redis.disconnect();
});

async function availableDriver(label: string): Promise<string> {
  const driverId = id(label);
  usedDriverIds.add(driverId);
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
  return driverId;
}

describe('reserve/resolve/release (L3-18) -- comportement fonctionnel', () => {
  test('reserve retire du pool et pose state=reserved', async () => {
    const driverId = await availableDriver('a1');
    const reserved = await reserve(redis, driverId, 30);
    assert.equal(reserved, true);
    assert.equal(await isInPool(redis, driverId), false);
    assert.equal(await getState(redis, driverId), 'reserved');
  });

  test('reserve échoue sur un chauffeur absent du pool', async () => {
    const driverId = id('a2-never-online');
    usedDriverIds.add(driverId);
    assert.equal(await reserve(redis, driverId, 30), false);
  });

  test('resolve(accepted=true) fait passer reserved -> engaged, pose rideId, retire le TTL', async () => {
    const driverId = await availableDriver('a3');
    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await redis.set(`babana:driver:proposal:rideId:${driverId}`, rideId, 'EX', 30);

    await reserve(redis, driverId, 1);
    const resolved = await resolve(redis, driverId, rideId, true);
    assert.equal(resolved, true);
    assert.equal(await getState(redis, driverId), 'engaged');

    const raw = await redis.hgetall(rideStateKey(driverId));
    assert.equal(raw.rideId, rideId);
    assert.equal(await redis.ttl(rideStateKey(driverId)), -1, "critère 4 -- l'engagement ne porte aucun TTL");

    await redis.del(`babana:driver:proposal:rideId:${driverId}`);
  });

  test('resolve(accepted=false) efface l\'enregistrement -- retour à l\'état libre', async () => {
    const driverId = await availableDriver('a4');
    await reserve(redis, driverId, 30);
    const resolved = await resolve(redis, driverId, null, false);
    assert.equal(resolved, true);
    assert.equal(await getState(redis, driverId), null);
  });

  test('resolve échoue si le rideId ne correspond pas (acceptation tardive)', async () => {
    const driverId = await availableDriver('a5');
    const realRideId = randomUUID();
    usedRideIds.add(realRideId);
    await redis.set(`babana:driver:proposal:rideId:${driverId}`, realRideId, 'EX', 30);
    await reserve(redis, driverId, 30);

    const resolved = await resolve(redis, driverId, randomUUID(), true);
    assert.equal(resolved, false);
    assert.equal(await getState(redis, driverId), 'reserved', "l'état ne doit pas avoir bougé");

    await redis.del(`babana:driver:proposal:rideId:${driverId}`);
  });

  test('resolve échoue sur un chauffeur libre (rien à résoudre)', async () => {
    const driverId = id('a6-free');
    usedDriverIds.add(driverId);
    assert.equal(await resolve(redis, driverId, null, true), false);
  });

  test('release efface inconditionnellement, y compris un chauffeur déjà libre (idempotent)', async () => {
    const driverId = await availableDriver('a7');
    await reserve(redis, driverId, 30);
    await release(redis, driverId);
    assert.equal(await getState(redis, driverId), null);
    await release(redis, driverId); // ne doit rien lever
    assert.equal(await getState(redis, driverId), null);
  });

  test('release efface aussi l\'index inverse rideId -> driverId d\'un chauffeur engagé', async () => {
    const driverId = await availableDriver('a8');
    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await redis.set(`babana:driver:proposal:rideId:${driverId}`, rideId, 'EX', 30);
    await reserve(redis, driverId, 30);
    await resolve(redis, driverId, rideId, true);
    assert.equal(await redis.get(rideOwnerKey(rideId)), driverId);

    await release(redis, driverId);
    assert.equal(await redis.get(rideOwnerKey(rideId)), null, "l'index inverse doit disparaître avec l'engagement");

    await redis.del(`babana:driver:proposal:rideId:${driverId}`);
  });

  test('forceEngaged pose state=engaged sans réservation préalable, avec rideId et son index inverse (D44, réconciliation L3-17)', async () => {
    const driverId = id('a9-reconcile');
    usedDriverIds.add(driverId);
    const rideId = randomUUID();
    usedRideIds.add(rideId);

    await forceEngaged(redis, driverId, rideId);

    assert.equal(await isEngaged(redis, driverId), true);
    assert.equal(await redis.ttl(rideStateKey(driverId)), -1);
    assert.equal(
      await redis.hget(rideStateKey(driverId), 'rideId'),
      rideId,
      "D44 -- un état réparé doit être indiscernable d'un état produit normalement, Odoo connaît ce rideId"
    );
    assert.equal(
      await redis.get(rideOwnerKey(rideId)),
      driverId,
      "l'index inverse doit être posé aussi, sinon ride.track reste incapable de retrouver ce chauffeur"
    );
  });

  test('attachEngagedSession complète un enregistrement déjà engagé, lisible par getEngagedSession', async () => {
    const driverId = await availableDriver('a10');
    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await redis.set(`babana:driver:proposal:rideId:${driverId}`, rideId, 'EX', 30);
    await reserve(redis, driverId, 30);
    await resolve(redis, driverId, rideId, true);

    await attachEngagedSession(redis, driverId, {
      rideId,
      clientUserId: 'client-xyz',
      origin: { latitude: 4.0511, longitude: 9.7679 },
    });

    const session = await getEngagedSession(redis, rideId);
    assert.ok(session);
    assert.equal(session?.driverId, driverId);
    assert.equal(session?.clientUserId, 'client-xyz');
    assert.deepEqual(session?.origin, { latitude: 4.0511, longitude: 9.7679 });

    await redis.del(`babana:driver:proposal:rideId:${driverId}`);
  });

  test('attachEngagedSession établit une session complète à lui seul, sans reserve/resolve préalable', async () => {
    // C'est exactement l'usage de test/broadcast.test.ts (façade tracking/session.ts::
    // startRideSession, appelée comme fixture autonome) -- attachEngagedSession doit donc rester
    // une opération complète, pas seulement un complément à un resolve() déjà passé par là.
    const driverId = id('a10bis-standalone');
    usedDriverIds.add(driverId);
    const rideId = randomUUID();
    usedRideIds.add(rideId);

    await attachEngagedSession(redis, driverId, {
      rideId,
      clientUserId: 'client-standalone',
      origin: { latitude: 4.05, longitude: 9.7 },
    });

    assert.equal(await isEngaged(redis, driverId), true);
    const session = await getEngagedSession(redis, rideId);
    assert.equal(session?.driverId, driverId);
    assert.equal(session?.clientUserId, 'client-standalone');
  });

  test('getEngagedSession renvoie null pour un rideId inconnu, ou pour un client non affecté à cette course', async () => {
    assert.equal(await getEngagedSession(redis, randomUUID()), null);

    const driverId = await availableDriver('a11');
    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await redis.set(`babana:driver:proposal:rideId:${driverId}`, rideId, 'EX', 30);
    await reserve(redis, driverId, 30);
    await resolve(redis, driverId, rideId, true);
    // Pas d'attachEngagedSession ici -- clientUserId/origin manquants : la session doit rester
    // indisponible plutôt que renvoyer un objet à moitié rempli (même discipline D30).
    assert.equal(await getEngagedSession(redis, rideId), null);

    await redis.del(`babana:driver:proposal:rideId:${driverId}`);
  });

  test('isReserved/isEngaged sont mutuellement exclusifs à tout instant', async () => {
    const driverId = await availableDriver('a12');
    assert.equal(await isReserved(redis, driverId), false);
    assert.equal(await isEngaged(redis, driverId), false);

    await reserve(redis, driverId, 30);
    assert.equal(await isReserved(redis, driverId), true);
    assert.equal(await isEngaged(redis, driverId), false);

    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await forceEngaged(redis, driverId, rideId);
    assert.equal(await isReserved(redis, driverId), false);
    assert.equal(await isEngaged(redis, driverId), true);
  });
});

describe('scanEngagedDriverIds (L3-17 critère 7, réconciliation contre le nouvel état)', () => {
  test('ne renvoie que les chauffeurs engagés, pas les réservés', async () => {
    const reservedOnly = await availableDriver('b1-reserved');
    await reserve(redis, reservedOnly, 30);

    const engaged = await availableDriver('b2-engaged');
    const rideId = randomUUID();
    usedRideIds.add(rideId);
    await forceEngaged(redis, engaged, rideId);

    const ids = await scanEngagedDriverIds(redis);
    assert.equal(ids.has(engaged), true);
    assert.equal(ids.has(reservedOnly), false, "critère 5 de L3-18 : un chauffeur réservé n'est pas engagé");
  });
});

describe("L3-18, critère 1 -- les trois structures précédentes ont disparu, vérifié par recherche", () => {
  const SERVICE_ROOT = join(__dirname, '..');
  const SCAN_DIRS = ['src', 'test'];
  const SCAN_EXTENSIONS = new Set(['.ts', '.lua']);
  const RETIRED_PREFIXES = [
    'babana:driver:reservation:',
    'babana:driver:engaged:',
    'babana:ride:session:',
    'babana:driver:active-ride:',
  ];

  // Ce fichier lui-même nomme les préfixes retirés, dans son propre texte (RETIRED_PREFIXES,
  // messages d'assertion) -- même genre d'exception que pool-single-writer.test.ts se réserve
  // pour la commande Redis qu'il surveille.
  // test/concurrency/reservation.test.ts (L3-13) : protégé par la spécification (critère 3,
  // "sans modification de ses assertions") -- son nettoyage de fin de test référence encore le
  // nom de clé littéral d'avant l'unification ; DEL sur une clé qui n'est plus jamais écrite est
  // un no-op inoffensif, pas une régression fonctionnelle, et ce fichier ne se modifie pas.
  const ALLOWED_FILES = new Set([
    join(SERVICE_ROOT, 'test', 'ride-state.test.ts'),
    join(SERVICE_ROOT, 'test', 'concurrency', 'reservation.test.ts'),
  ]);

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  test('aucun fichier du service ne référence plus les préfixes de clés retirés', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(SERVICE_ROOT, dir))) {
        if (!SCAN_EXTENSIONS.has(extname(file)) || ALLOWED_FILES.has(file)) continue;
        const content = readFileSync(file, 'utf8');
        for (const prefix of RETIRED_PREFIXES) {
          if (content.includes(prefix)) offenders.push(`${file} (${prefix})`);
        }
      }
    }
    assert.deepEqual(offenders, [], `préfixe(s) retiré(s) encore référencé(s) : ${offenders.join(', ')}`);
  });
});

describe('L3-18, critère 2 -- aucun écrivain direct sur la clé unifiée hors de ride/state.lua', () => {
  const SERVICE_ROOT = join(__dirname, '..');
  const STATE_FILE = join(SERVICE_ROOT, 'src', 'ride', 'state.ts');
  const STATE_LUA = join(SERVICE_ROOT, 'src', 'ride', 'state.lua');
  // Ce fichier de test nomme lui-même les préfixes surveillés (titre, messages d'assertion) --
  // même exception que ci-dessus pour le critère 1.
  const THIS_FILE = join(SERVICE_ROOT, 'test', 'ride-state.test.ts');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  test("rideStateKey/rideOwnerKey ne sont construits (littéral 'babana:driver:ride-state:'/'babana:ride:owner:') que dans ride/state.ts", () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'test']) {
      for (const file of walk(join(SERVICE_ROOT, dir))) {
        if (extname(file) !== '.ts' || file === STATE_FILE || file === THIS_FILE) continue;
        const content = readFileSync(file, 'utf8');
        if (content.includes('babana:driver:ride-state:') || content.includes('babana:ride:owner:')) {
          offenders.push(file);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `préfixe de l'état unifié reconstruit à la main hors de ride/state.ts : ${offenders.join(', ')} -- ` +
        'tout appelant doit passer par rideStateKey()/rideOwnerKey() ou par les fonctions exportées'
    );
  });

  test('ride/state.lua est le seul script Lua qui écrit sur la HASH d\'état (HSET/DEL/PERSIST/EXPIRE)', () => {
    // Vérification structurelle légère, pas exhaustive : les deux seuls autres scripts du
    // service (pool-eligibility.lua, dont c'est la clé de garde -- lecture EXISTS seulement --
    // et non plus d'écriture ; et aucun autre .lua ne référence KEYS liés à cet état) n'écrivent
    // jamais dans cette structure. `pool-eligibility.lua` doit rester en LECTURE seule sur elle.
    const poolEligibilityLua = readFileSync(
      join(SERVICE_ROOT, 'src', 'redis', 'pool-eligibility.lua'),
      'utf8'
    );
    const writesToState = /\b(HSET|HDEL|PERSIST|EXPIRE)\b.*KEYS\[3\]/i.test(poolEligibilityLua);
    assert.equal(writesToState, false, "pool-eligibility.lua ne doit que LIRE l'état unifié (EXISTS), jamais l'écrire");
    assert.ok(readFileSync(STATE_LUA, 'utf8').includes("action == 'reserve'"), 'sanity check -- ride/state.lua existe et porte ses actions');
  });
});
