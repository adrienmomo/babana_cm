import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ClientToServerMessageSchema,
  PositionUpdateMessageSchema,
  AvailabilitySetMessageSchema,
  ProposalAcceptMessageSchema,
  ProposalRejectMessageSchema,
  ProposalSeenMessageSchema,
  NearbySubscribeMessageSchema,
  NearbyUnsubscribeMessageSchema,
  RideTrackMessageSchema,
  SessionResyncMessageSchema,
} from '../src/realtime/client-to-server';
import {
  ProposalNewMessageSchema,
  ProposalExpiredMessageSchema,
  ProposalAcceptedMessageSchema,
  RideCancelledMessageSchema,
  NearbyDriversMessageSchema,
  NearbySubscribeAckMessageSchema,
  RideTrackAckMessageSchema,
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
    // Forme additive (L6-05) : un message à un seul point (aucun `precedingSamples` fourni) reste
    // valide, avec un tableau vide par défaut -- compatible avec tout appelant antérieur à L6-05.
    assert.deepEqual(msg.payload.precedingSamples, []);
  });

  test('position.update -- agrégation (L6-05) : plusieurs relevés accumulés dans un seul message', () => {
    const msg = PositionUpdateMessageSchema.parse({
      type: 'position.update',
      id: randomUUID(),
      emittedAt: now,
      payload: {
        latitude: 4.05,
        longitude: 9.76,
        accuracyMeters: 8,
        speedMetersPerSecond: 6.2,
        headingDegrees: 180,
        precedingSamples: [
          { latitude: 4.049, longitude: 9.759, accuracyMeters: 10, speedMetersPerSecond: 5.8, headingDegrees: 178, capturedAt: now },
          { latitude: 4.0495, longitude: 9.7595, accuracyMeters: 9, speedMetersPerSecond: 6.0, headingDegrees: 179, capturedAt: now },
        ],
      },
    });
    assert.equal(msg.payload.precedingSamples.length, 2);
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

  test('proposal.accept / proposal.reject', () => {
    assert.doesNotThrow(() =>
      ProposalAcceptMessageSchema.parse({ type: 'proposal.accept', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      ProposalRejectMessageSchema.parse({ type: 'proposal.reject', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
  });

  test('proposal.seen (L7-04) -- porte l\'emittedAt d\'origine de la proposition', () => {
    assert.doesNotThrow(() =>
      ProposalSeenMessageSchema.parse({
        type: 'proposal.seen',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, emittedAt: now },
      })
    );
    // `emittedAt` de la charge utile est requis : sans lui, aucun délai à mesurer.
    assert.throws(() =>
      ProposalSeenMessageSchema.parse({ type: 'proposal.seen', id: randomUUID(), emittedAt: now, payload: { rideId } })
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
  test('proposal.new / proposal.expired / ride.cancelled', () => {
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
          distanceToOriginMeters: 850,
          expiresAt: now,
        },
      })
    );
    // D51 : la distance à vide peut être null (position du chauffeur non lisible au moment de la
    // réservation), mais le champ lui-même n'est jamais absent.
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
          distanceToOriginMeters: null,
          expiresAt: now,
        },
      })
    );
    assert.throws(() =>
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
      ProposalAcceptedMessageSchema.parse({
        type: 'proposal.accepted',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, clientPhoneNumber: '+237691234567' },
      })
    );
    // D42 : nullable (pas absent) -- même filet que le reste de ride.assigned (D30), mais le champ
    // lui-même est requis.
    assert.doesNotThrow(() =>
      ProposalAcceptedMessageSchema.parse({
        type: 'proposal.accepted',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, clientPhoneNumber: null },
      })
    );
    assert.throws(() =>
      ProposalAcceptedMessageSchema.parse({ type: 'proposal.accepted', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    assert.doesNotThrow(() =>
      RideCancelledMessageSchema.parse({
        type: 'ride.cancelled',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, cancelledBy: 'client' },
      })
    );
  });

  test('ride.cancelled exige cancelledBy (L4-12) -- le destinataire doit savoir lequel des deux cas s\'est produit', () => {
    assert.throws(() =>
      RideCancelledMessageSchema.parse({ type: 'ride.cancelled', id: randomUUID(), emittedAt: now, payload: { rideId } })
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
          phoneNumber: '+237691234567',
        },
      })
    );
    // D42 : requis mais nullable -- absent doit échouer, null doit passer (même filet que les
    // quatre autres champs de ride.assigned, D30).
    assert.throws(() =>
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
        payload: { rideId, position: { latitude: 4.051, longitude: 9.768 }, etaSeconds: 180 },
      })
    );
    assert.doesNotThrow(() =>
      RideStartedMessageSchema.parse({ type: 'ride.started', id: randomUUID(), emittedAt: now, payload: { rideId } })
    );
    const completedBreakdown = {
      baseFare: 200,
      distanceFare: 900,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 100,
      minimumFareApplied: false,
    };
    assert.doesNotThrow(() =>
      RideCompletedMessageSchema.parse({
        type: 'ride.completed',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          rideId,
          distanceMeters: 4300,
          durationSeconds: 800,
          measured: true,
          amount: 1200,
          breakdown: completedBreakdown,
        },
      })
    );
    // J24 (amoa/questions/L6-13.md) : course terminée sans accumulation temps réel -- distance
    // et durée à `null`, `measured: false`. Une absence assumée, jamais un chiffre plausible.
    assert.doesNotThrow(() =>
      RideCompletedMessageSchema.parse({
        type: 'ride.completed',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          rideId,
          distanceMeters: null,
          durationSeconds: null,
          measured: false,
          amount: 1200,
          breakdown: completedBreakdown,
        },
      })
    );
    assert.throws(() =>
      RideCompletedMessageSchema.parse({
        type: 'ride.completed',
        id: randomUUID(),
        emittedAt: now,
        payload: { rideId, distanceMeters: 4300, durationSeconds: 800, amount: 1200, breakdown: completedBreakdown },
      })
    );
  });

  test('session.synced', () => {
    assert.doesNotThrow(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          activeRideId: rideId,
          activeRideState: 'in_progress',
          activeProposal: null,
          rideStateKnown: true,
          serverTime: now,
        },
      })
    );
    // L7-04 : une proposition active retrouvée par resynchronisation -- même forme que
    // proposal.new, plus emittedAt (l'échéance portée est la véritable, pas trente secondes).
    assert.doesNotThrow(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          activeRideId: null,
          activeRideState: null,
          activeProposal: {
            rideId,
            origin: { latitude: 4.05, longitude: 9.7 },
            destination: { latitude: 4.06, longitude: 9.71 },
            amount: 1500,
            distanceMeters: 2400,
            distanceToOriginMeters: 800,
            expiresAt: now,
            emittedAt: now,
          },
          rideStateKnown: true,
          serverTime: now,
        },
      })
    );
    // L7-04 (6 septembre) : Odoo injoignable -- la réponse part quand même, elle porte la
    // proposition connue localement et dit que l'état de course est indéterminé.
    assert.doesNotThrow(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: {
          activeRideId: null,
          activeRideState: null,
          activeProposal: null,
          rideStateKnown: false,
          serverTime: now,
        },
      })
    );
    // `activeProposal` est requis (jamais implicite) : l'absence se dit avec `null`.
    assert.throws(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: { activeRideId: rideId, activeRideState: 'in_progress', rideStateKnown: true, serverTime: now },
      })
    );
    // `rideStateKnown` est requis lui aussi : dire explicitement si l'état est connu.
    assert.throws(() =>
      SessionSyncedMessageSchema.parse({
        type: 'session.synced',
        id: randomUUID(),
        emittedAt: now,
        payload: { activeRideId: rideId, activeRideState: 'in_progress', activeProposal: null, serverTime: now },
      })
    );
  });

  test('nearby.subscribe.ack -- accepté (avec la cadence, D50), ou refusé avec un délai avant nouvelle tentative', () => {
    assert.doesNotThrow(() =>
      NearbySubscribeAckMessageSchema.parse({
        type: 'nearby.subscribe.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: { accepted: true, broadcastIntervalMs: 5000 },
      })
    );
    // D50 : un accusé accepté sans cadence est inexploitable pour la surveillance de silence (L3-20).
    assert.throws(() =>
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

  test('ride.track.ack -- porte la cadence réelle de driver.position (D50)', () => {
    assert.doesNotThrow(() =>
      RideTrackAckMessageSchema.parse({
        type: 'ride.track.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: { broadcastIntervalMs: 10_000 },
      })
    );
    assert.throws(() =>
      RideTrackAckMessageSchema.parse({
        type: 'ride.track.ack',
        id: randomUUID(),
        emittedAt: now,
        payload: {},
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

  test('plafonne à 5 chauffeurs (C2b)', () => {
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
    const raw = { type: 'proposal.accept' as const, id, emittedAt: now, payload: { rideId } };
    const first = ProposalAcceptMessageSchema.parse(raw);
    const second = ProposalAcceptMessageSchema.parse(raw);
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
