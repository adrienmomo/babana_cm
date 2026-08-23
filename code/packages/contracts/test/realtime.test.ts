import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ClientToServerMessageSchema,
  PositionUpdateMessageSchema,
  AvailabilitySetMessageSchema,
  ProposalAcceptMessageSchema,
  ProposalRejectMessageSchema,
  RideStartMessageSchema,
  RideCompleteMessageSchema,
  NearbySubscribeMessageSchema,
  NearbyUnsubscribeMessageSchema,
  RideTrackMessageSchema,
  SessionResyncMessageSchema,
} from '../src/realtime/client-to-server';
import {
  ProposalNewMessageSchema,
  ProposalExpiredMessageSchema,
  RideCancelledMessageSchema,
  CashLimitWarningMessageSchema,
  NearbyDriversMessageSchema,
  NearbySubscribeAckMessageSchema,
  RideProposedMessageSchema,
  RideAssignedMessageSchema,
  RideRejectedMessageSchema,
  DriverPositionMessageSchema,
  RideStartedMessageSchema,
  RideCompletedMessageSchema,
  SessionSyncedMessageSchema,
  ServerToClientMessageSchema,
} from '../src/realtime/server-to-client';
import { NEARBY_POSITION_PRECISION_DECIMALS, roundToNearbyPrecision } from '../src/http/common';

const rideId = randomUUID();
const driverId = randomUUID();
const now = '2026-08-10T07:00:00+01:00';

describe('critère 1 — chaque message a un nom, un schéma, et un émetteur unique', () => {
  test('aucun nom de message ne figure à la fois dans ClientToServer et ServerToClient', () => {
    const clientToServerTypes: string[] = ClientToServerMessageSchema.options.map((s) => s.shape.type.value);
    const serverToClientTypes: string[] = ServerToClientMessageSchema.options.map((s) => s.shape.type.value);
    const overlap = clientToServerTypes.filter((t) => serverToClientTypes.includes(t));
    assert.deepEqual(overlap, []);
  });

  test('aucun nom de message n\'est dupliqué au sein d\'une même direction', () => {
    for (const schema of [ClientToServerMessageSchema, ServerToClientMessageSchema]) {
      const types = schema.options.map((s) => s.shape.type.value);
      assert.deepEqual(types.length, new Set(types).size);
    }
  });
});

describe('exemples valides — chauffeur vers serveur', () => {
  test('position.update', () => {
    const msg = PositionUpdateMessageSchema.parse({
      type: 'position.update',
      id: randomUUID(),
      emittedAt: now,
      payload: { latitude: 4.05, longitude: 9.76, accuracyMeters: 8, speedMetersPerSecond: 6.2, headingDegrees: 180 },
    });
    assert.equal(msg.type, 'position.update');
  });

  test('availability.set', () => {
    assert.doesNotThrow(() =>
      AvailabilitySetMessageSchema.parse({
        type: 'availability.set',
        id: randomUUID(),
        emittedAt: now,
        payload: { online: true },
      })
    );
  });

  test('proposal.accept / proposal.reject / ride.start / ride.complete', () => {
    assert.doesNotThrow(() =>
      ProposalAcceptMessageSchema.parse({ type: 'proposal.accept', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      ProposalRejectMessageSchema.parse({ type: 'proposal.reject', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      RideStartMessageSchema.parse({ type: 'ride.start', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      RideCompleteMessageSchema.parse({
        type: 'ride.complete',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, distanceMeters: 4300, durationSeconds: 800, polyline: 'a~l~F' },
      })
    );
  });
});

describe('exemples valides — client vers serveur', () => {
  test('nearby.subscribe / nearby.unsubscribe / ride.track', () => {
    assert.doesNotThrow(() =>
      NearbySubscribeMessageSchema.parse({
        type: 'nearby.subscribe',
        id: randomUUID(),
        emittedAt: now,
        payload: { position: { latitude: 4.05, longitude: 9.76 }, radiusMeters: 2000 },
      })
    );
    assert.doesNotThrow(() =>
      NearbyUnsubscribeMessageSchema.parse({ type: 'nearby.unsubscribe', id: randomUUID(), emittedAt: now, payload: {} })
    );
    assert.doesNotThrow(() =>
      RideTrackMessageSchema.parse({ type: 'ride.track', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
  });

  test('session.resync', () => {
    assert.doesNotThrow(() =>
      SessionResyncMessageSchema.parse({
        type: 'session.resync',
        id: randomUUID(),
        emittedAt: now,
        payload: { lastKnownRideId: rideId },
      })
    );
  });
});

describe('exemples valides — serveur vers chauffeur', () => {
  test('proposal.new / proposal.expired / ride.cancelled / cash.limit.warning', () => {
    assert.doesNotThrow(() =>
      ProposalNewMessageSchema.parse({
        type: 'proposal.new',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          rideId,
          origin: { latitude: 4.05, longitude: 9.76 },
          destination: { latitude: 4.06, longitude: 9.78 },
          amount: 1200,
          distanceMeters: 4200,
          expiresAt: now,
        },
      })
    );
    assert.doesNotThrow(() =>
      ProposalExpiredMessageSchema.parse({ type: 'proposal.expired', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      RideCancelledMessageSchema.parse({ type: 'ride.cancelled', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      CashLimitWarningMessageSchema.parse({
        type: 'cash.limit.warning',
        id: randomUUID(),
        emittedAt: now,
        payload: { balance: 14000, limit: 15000 },
      })
    );
  });
});

describe('exemples valides — serveur vers client', () => {
  test('nearby.drivers / ride.proposed / ride.assigned / ride.rejected / driver.position / ride.started / ride.completed', () => {
    assert.doesNotThrow(() =>
      NearbyDriversMessageSchema.parse({
        type: 'nearby.drivers',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          drivers: [
            {
              driverId,
              firstName: 'Paul',
              photoUrl: null,
              rating: 4.8,
              motorcycleClass: 'standard',
              position: { latitude: 4.0509, longitude: 9.7683 },
              distanceMeters: 350,
            },
          ],
        },
      })
    );
    assert.doesNotThrow(() =>
      RideProposedMessageSchema.parse({
        type: 'ride.proposed',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, driverId, proposalExpiresAt: now },
      })
    );
    assert.doesNotThrow(() =>
      RideAssignedMessageSchema.parse({
        type: 'ride.assigned',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          rideId,
          driverId,
          firstName: 'Paul',
          photoUrl: null,
          motorcycleClass: 'standard',
          licensePlate: 'LT-1234-BC',
        },
      })
    );
    assert.doesNotThrow(() =>
      RideRejectedMessageSchema.parse({
        type: 'ride.rejected',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, driverId, reason: 'driver_rejected' },
      })
    );
    assert.doesNotThrow(() =>
      DriverPositionMessageSchema.parse({
        type: 'driver.position',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, position: { latitude: 4.051, longitude: 9.768 } },
      })
    );
    assert.doesNotThrow(() =>
      RideStartedMessageSchema.parse({ type: 'ride.started', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      RideCompletedMessageSchema.parse({
        type: 'ride.completed',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          rideId,
          distanceMeters: 4300,
          durationSeconds: 800,
          amount: 1200,
          breakdown: {
            baseFare: 200,
            distanceFare: 900,
            surgeAmount: 0,
            discountAmount: 0,
            floorAmount: 0,
            roundingAmount: 100,
            minimumFareApplied: false,
          },
        },
      })
    );
  });

  test('session.synced', () => {
    assert.doesNotThrow(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: { activeRideId: rideId, activeRideState: 'in_progress', serverTime: now },
      })
    );
  });

  test('nearby.subscribe.ack -- accepté, ou refusé avec un délai avant nouvelle tentative', () => {
    assert.doesNotThrow(() =>
      NearbySubscribeAckMessageSchema.parse({
        type: 'nearby.subscribe.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: { accepted: true },
      })
    );
    assert.doesNotThrow(() =>
      NearbySubscribeAckMessageSchema.parse({
        type: 'nearby.subscribe.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: { accepted: false, retryAfterMs: 5000 },
      })
    );
    // Un refus sans délai serait inexploitable côté client (spécification L6-06).
    assert.throws(() =>
      NearbySubscribeAckMessageSchema.parse({
        type: 'nearby.subscribe.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: { accepted: false },
      })
    );
  });
});

describe('critère 3 — nearby.drivers ne dépasse jamais le minimum de données personnelles', () => {
  test('rejette un champ en trop', () => {
    assert.throws(() =>
      NearbyDriversMessageSchema.parse({
        type: 'nearby.drivers',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          drivers: [
            {
              driverId,
              firstName: 'Paul',
              lastName: 'Mbarga',
              photoUrl: null,
              rating: 4.8,
              motorcycleClass: 'standard',
              position: { latitude: 4.05, longitude: 9.76 },
              distanceMeters: 300,
            },
          ],
        },
      })
    );
  });

  test('plafonne à 5 chauffeurs, comme la réponse REST équivalente (C-01)', () => {
    const drivers = Array.from({ length: 6 }, (_, i) => ({
      driverId: `00000000-0000-4000-8000-00000000000${i}`,
      firstName: 'X',
      photoUrl: null,
      rating: 5,
      motorcycleClass: 'standard',
      position: { latitude: 4.05, longitude: 9.76 },
      distanceMeters: 100,
    }));
    assert.throws(() =>
      NearbyDriversMessageSchema.parse({ type: 'nearby.drivers', id: randomUUID(), emittedAt: now, payload: { drivers } })
    );
  });
});

describe('idempotence — l\'identifiant d\'enveloppe est stable pour un message rejoué', () => {
  test('deux parse() du même message conservent le même id', () => {
    const id = randomUUID();
    const raw = { type: 'ride.start' as const, id, emittedAt: now, payload: { rideId } };
    const first = RideStartMessageSchema.parse(raw);
    const second = RideStartMessageSchema.parse(raw);
    assert.equal(first.id, second.id);
  });
});

describe('précision des positions diffusées (C2b)', () => {
  test('roundToNearbyPrecision arrondit à NEARBY_POSITION_PRECISION_DECIMALS décimales', () => {
    assert.equal(roundToNearbyPrecision(4.051234567), Number(4.051234567.toFixed(NEARBY_POSITION_PRECISION_DECIMALS)));
    assert.equal(NEARBY_POSITION_PRECISION_DECIMALS, 4);
  });

  test('la précision est assez grossière pour ne pas identifier un point au mètre près', () => {
    const rounded = roundToNearbyPrecision(4.05123456);
    const decimals = rounded.toString().split('.')[1]?.length ?? 0;
    assert.ok(decimals <= NEARBY_POSITION_PRECISION_DECIMALS);
  });
});
