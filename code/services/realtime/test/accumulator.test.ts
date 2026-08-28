// Contre un Redis réel, comme internal.test.ts / reservation.test.ts : l'accumulation (L3-10) vit
// entièrement dans un HASH Redis (aucun état en mémoire du processus), et c'est précisément cette
// propriété -- restart-safe (L3-14) -- qu'une imitation en mémoire ne prouverait pas.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  startAccumulation,
  accumulatePosition,
  getAccumulation,
  endAccumulation,
  accumulationKey,
  encodePolyline,
  type AccumulationConfig,
} from '../src/tracking/accumulator';
import { ingestPosition } from '../src/tracking/ingest';
import type { PlausibilityConfig } from '../src/tracking/validation';
import type { ConnectionContext } from '../src/ws/auth';

// DB logique dédiée (index 1) : ce fichier fait beaucoup d'écritures Redis réelles (boucles de
// positions, ingestPosition) et un `flushdb` en tête de chaque test -- l'isoler du DB 0 partagé
// par les autres tests du service évite toute interférence de timing avec les tests sensibles à
// l'expiration (reservation.test.ts, L3-06). C'est toujours un vrai Redis (l'accumulation vit
// dans un HASH -- ce qu'un faux Redis ne prouverait pas), seulement une autre base.
const REDIS_URL = `${process.env.REDIS_URL ?? 'redis://localhost:6379'}/1`;

const CONFIG: AccumulationConfig = {
  minSegmentMeters: 5,
  simplifyToleranceMeters: 8,
  maxTrackPoints: 500,
  ttlSeconds: 3600,
};

const PLAUSIBILITY: PlausibilityConfig = {
  bounds: { minLatitude: 3.95, maxLatitude: 4.15, minLongitude: 9.6, maxLongitude: 9.85 },
  maxAccuracyMeters: 150,
  maxTimestampFutureMs: 5_000,
  maxTimestampAgeMs: 30_000,
  maxImpliedSpeedMetersPerSecond: 38.9,
};

function driverContext(id: string): ConnectionContext {
  return Object.freeze({ userId: `user-${id}`, role: 'driver', driverId: id }) as ConnectionContext;
}

function positionUpdate(latitude: number, longitude: number, accuracyMeters: number, atMs: number) {
  return {
    type: 'position.update' as const,
    id: `msg-${Math.random().toString(36).slice(2)}`,
    emittedAt: new Date(atMs).toISOString(),
    payload: {
      latitude,
      longitude,
      accuracyMeters,
      speedMetersPerSecond: 8,
      headingDegrees: 90,
      // Cette fixture construit le message à la main, sans passer par
      // PositionUpdatePayloadSchema.parse() (seul à appliquer le défaut Zod) -- L6-05.
      precedingSamples: [] as never[],
    },
  };
}

let redis: Redis;
let driverId: string;

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await redis.flushdb();
  await redis.quit();
});

beforeEach(async () => {
  driverId = `accum-${randomUUID().slice(0, 8)}`;
  await redis.flushdb();
});

/** ~1 m ≈ 9e-6 degrés de latitude à Douala. Décale un point de `metersNorth` / `metersEast`. */
function offset(lat: number, lng: number, metersNorth: number, metersEast: number) {
  const dLat = metersNorth / 111_320;
  const dLng = metersEast / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + dLat, longitude: lng + dLng };
}

const ORIGIN = { latitude: 4.05, longitude: 9.7 };

/** Décode une polyline Google (précision 5) -> liste de [lat, lng]. */
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

describe('accumulateur de course (L3-10)', () => {
  test('sans accumulation active, getAccumulation renvoie null et accumulatePosition ne fait rien', async () => {
    assert.equal(await getAccumulation(redis, driverId), null);
    await accumulatePosition(redis, driverId, ORIGIN, CONFIG); // ne doit pas lever ni créer la clé
    assert.equal(await redis.exists(accumulationKey(driverId)), 0);
  });

  test('critère 1 -- une moto à l’arrêt avec du bruit GPS n’accumule pas de distance', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    // 30 positions dans une boule de ~1,5 m autour du même point : du bruit GPS, jamais un
    // déplacement -- toutes restent sous le seuil de segment minimal (5 m) par rapport au premier
    // point retenu.
    for (let i = 0; i < 30; i += 1) {
      const north = (i % 4) - 1.5;
      const east = ((i * 3) % 4) - 1.5;
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, north, east), CONFIG);
    }
    const measurement = await getAccumulation(redis, driverId);
    assert.equal(measurement?.distanceMeters, 0, 'aucune distance ne doit être accumulée à l’arrêt');
  });

  test('un déplacement réel accumule la distance par sommation des segments', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    // 10 pas de 100 m plein est.
    for (let i = 0; i <= 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, i * 100), CONFIG);
    }
    const measurement = await getAccumulation(redis, driverId);
    assert.ok(
      Math.abs((measurement?.distanceMeters ?? 0) - 1000) < 20,
      `~1000 m attendus, obtenu ${measurement?.distanceMeters}`
    );
  });

  test('critère 3 -- le tracé simplifié conserve la forme : une ligne droite se réduit à ses extrémités', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    for (let i = 0; i <= 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, i * 30), CONFIG);
    }
    const measurement = await getAccumulation(redis, driverId);
    const decoded = decodePolyline(measurement!.polyline);
    assert.equal(decoded.length, 2, `une ligne droite -> 2 sommets, obtenu ${decoded.length}`);
  });

  test('critère 3 -- une forme en L garde son coin', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    // 6 pas plein est, puis 6 pas plein nord depuis le coin.
    for (let i = 0; i <= 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, i * 40), CONFIG);
    }
    for (let i = 1; i <= 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, i * 40, 6 * 40), CONFIG);
    }
    const measurement = await getAccumulation(redis, driverId);
    const decoded = decodePolyline(measurement!.polyline);
    assert.equal(decoded.length, 3, `un L -> 3 sommets (départ, coin, arrivée), obtenu ${decoded.length}`);
  });

  test('critère 4 -- une coupure suivie d’une reprise ne perd pas l’accumulation en cours', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    for (let i = 0; i <= 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, i * 100), CONFIG);
    }
    const half = await getAccumulation(redis, driverId);
    assert.ok((half?.distanceMeters ?? 0) > 400);

    // « Redémarrage » : aucune fonction ne garde d'état en mémoire -- on reprend simplement les
    // appels contre le même Redis, exactement ce que ferait le processus relancé.
    for (let i = 6; i <= 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, i * 100), CONFIG);
    }
    const full = await getAccumulation(redis, driverId);
    assert.ok(
      Math.abs((full?.distanceMeters ?? 0) - 1200) < 30,
      `l’accumulation reprend là où elle en était (~1200 m), obtenu ${full?.distanceMeters}`
    );
  });

  test('la durée est le temps d’horloge écoulé depuis ride.start', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000_000);
    const measurement = await getAccumulation(redis, driverId, 1_000_000 + 90_000);
    assert.equal(measurement?.durationSeconds, 90);
  });

  test('endAccumulation efface le relevé -- getAccumulation renvoie de nouveau null', async () => {
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, 1_000);
    await accumulatePosition(redis, driverId, offset(ORIGIN.latitude, ORIGIN.longitude, 0, 200), CONFIG);
    assert.notEqual(await getAccumulation(redis, driverId), null);

    await endAccumulation(redis, driverId);
    assert.equal(await getAccumulation(redis, driverId), null);
  });

  test('critère 2 -- une position rejetée par la plausibilité n’est jamais accumulée', async () => {
    const ctx = driverContext(driverId);
    const now = Date.now();
    await startAccumulation(redis, driverId, CONFIG.ttlSeconds, now);

    // Précision de 500 m : rejetée par L3-02 (maxAccuracyMeters = 150) -- ne doit jamais atteindre
    // l'accumulation (ingestPosition renvoie avant l'appel à accumulatePosition).
    const rejected = await ingestPosition(
      redis,
      ctx,
      positionUpdate(ORIGIN.latitude, ORIGIN.longitude, 500, now),
      PLAUSIBILITY,
      60,
      now,
      CONFIG
    );
    assert.equal(rejected.accepted, false);
    const afterReject = await getAccumulation(redis, driverId, now);
    assert.equal(afterReject?.distanceMeters, 0);
    assert.equal(afterReject?.pointCount, 0);

    // Deux positions valides à 100 m d'écart : elles, sont bien accumulées.
    await ingestPosition(redis, ctx, positionUpdate(ORIGIN.latitude, ORIGIN.longitude, 20, now), PLAUSIBILITY, 60, now, CONFIG);
    const p2 = offset(ORIGIN.latitude, ORIGIN.longitude, 0, 100);
    await ingestPosition(redis, ctx, positionUpdate(p2.latitude, p2.longitude, 20, now + 15_000), PLAUSIBILITY, 60, now + 15_000, CONFIG);

    const afterAccept = await getAccumulation(redis, driverId, now + 15_000);
    assert.ok((afterAccept?.distanceMeters ?? 0) > 90 && (afterAccept?.distanceMeters ?? 0) < 110);
  });

  test('encodePolyline / decodePolyline : aller-retour sur un exemple', () => {
    const points: [number, number][] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    assert.equal(encodePolyline(points), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});
