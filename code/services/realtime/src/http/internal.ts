import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import { z } from 'zod';
import { http as httpContract } from '@babana/contracts';
import type { Config } from '../config';
import type { ProposalLifecycle, ProposalDetails } from '../proposal/lifecycle';
import type { ConnectionRegistry } from '../ws/auth';
import { withIdempotency } from '../reservation/idempotency';
import { clearEngaged } from '../driver/engagement';
import { endRideSessionForDriver } from '../tracking/session';
import { reintegrateIfEligible } from '../redis/pool-eligibility';
import { findNearby } from '../redis/geo-index';
import { blockForCash, unblockForCash } from '../driver/cash-guard';
import { holdDriver, releaseHold } from '../driver/admin-hold';
import { broadcastRideStarted, broadcastRideCompleted, broadcastRideCancelled, broadcastRideUnmatched } from '../tracking/broadcast';
import { startAccumulation, getAccumulation, endAccumulation } from '../tracking/accumulator';
import { recordDriverArrived } from '../tracking/route';

/**
 * Endpoint HTTP interne, sens Odoo -> temps réel (L3-17). Authentifié par `REALTIME_SHARED_SECRET`
 * (même secret, même mécanisme que le sens sortant de L3-12/L3-15 -- pas un second à inventer),
 * **jamais exposé publiquement** : Caddy ne route jamais vers `/internal/*` depuis l'extérieur
 * (infra/caddy/Caddyfile ne sert que `/rt/*`), et le secret est une seconde barrière, indépendante
 * du routage -- défense en profondeur, pas un unique point de défaillance.
 *
 * Trois routes :
 * - `POST /internal/reservations/nearest` : le serveur choisit le chauffeur (le client ne le
 *   désigne plus, D10 retiré) -- réserve le disponible le plus proche (hors chauffeurs déjà
 *   sollicités pour la course) et lui propose la course, en un geste atomique, avant la transition
 *   Odoo. Idempotent (D25, le piège du rejeu -- voir reservation/idempotency.ts).
 *   `NO_DRIVER_AVAILABLE` si personne.
 * - `POST /internal/drivers/nearby` : lecture seule -- les disponibles les plus proches et leur
 *   position, pour qu'Odoo mesure leur distance routière (prise en charge moyenne à l'estimation,
 *   classement avant la réservation). Aucun commit à attendre (D32).
 * - `POST /internal/rides/unmatched` : plus aucun chauffeur à solliciter (au COMMIT d'Odoo, D32)
 *   -- pousse `ride.unmatched` au client.
 * - `POST /internal/reservations/release` : compensation quand la réservation a réussi mais que la
 *   transition Odoo qui devait suivre échoue (critère 4).
 * - `POST /internal/engagement/clear` : fin de course, efface le marqueur d'engagement (critère 6).
 * - `POST /internal/drivers/cash-blocked` : plafond d'encaisse franchi (D8, D28, L5-02), retire
 *   du pool et bloque toute acceptation en vol pour ce chauffeur.
 * - `POST /internal/drivers/cash-unblocked` : remise de caisse validée, le chauffeur repasse
 *   sous le plafond (D8, L5-04, critère 5) -- lève le blocage et le réintègre au pool s'il est
 *   par ailleurs toujours éligible (en ligne, positionné, ni engagé ni réservé). Ne le remet
 *   jamais en ligne lui-même -- symétrique de `cash-blocked`, jamais un ajout inconditionnel.
 * - `POST /internal/drivers/unavailable` : dossier chauffeur non habilité à travailler (D5, D31,
 *   D55, J33) -- suspension ou rejet côté Odoo. Retire du pool et bloque toute acceptation en vol,
 *   même patron que `cash-blocked`. Déclenché au COMMIT (D32) par `babana.driver.write()`.
 * - `POST /internal/drivers/available` : réactivation d'un chauffeur suspendu (J33) -- lève la
 *   non-habilitation. À la différence de `cash-unblocked`, NE réintègre PAS au pool : un chauffeur
 *   réactivé se redéclare en ligne lui-même (D7, prompt J33).
 * - `POST /internal/rides/started` / `/internal/rides/completed` (L3-19) : pousse
 *   `ride.started`/`ride.completed` (C-02) au client suivi ET au chauffeur -- déclenché au
 *   COMMIT (D32) par `action_start`/`action_complete`. `started` démarre en plus l'accumulation
 *   distance/durée/tracé (L3-10).
 * - `POST /internal/rides/arrived` : « Sur place » écrit par Odoo (`action_mark_arrived`, au
 *   COMMIT, D32) -- pousse `driver.arrived` au client et au chauffeur, et le garde pour le rejeu.
 * - `POST /internal/rides/measurement` (L3-10) : renvoie le relevé de trajet accumulé pour un
 *   chauffeur -- LU par Odoo AVANT la transition `in_progress -> completed` (une lecture, jamais
 *   une écriture Redis : sans risque D25/D32, même exception assumée que `reserve_and_propose`).
 *   `{ measured: false }` si aucune accumulation n'est active.
 * - `POST /internal/rides/cancelled` (L4-12) : pousse `ride.cancelled` (C-02) aux destinataires
 *   qu'Odoo désigne (`notifyClientUserId`/`notifyDriverId`, chacun optionnel -- le destinataire
 *   dépend de l'acteur, jamais celui qui vient de décider). Déclenché au COMMIT (D32) par
 *   `action_cancel`. Ne touche aucun état Redis : notifie, ne transitionne rien (D31).
 */

export const INTERNAL_PATH_PREFIX = '/internal/';

export function isInternalPath(pathname: string): boolean {
  return pathname.startsWith(INTERNAL_PATH_PREFIX);
}

export interface InternalRouterDeps {
  config: Config;
  redis: Redis;
  proposals: ProposalLifecycle;
  registry: ConnectionRegistry;
}

// Le serveur choisit le chauffeur : le détail de la course, le rayon de recherche (réglage métier
// d'Odoo, babana.dispatch_radius_meters -- jamais une valeur de ce service) et les chauffeurs déjà
// sollicités pour cette course. Aucun `driverId` : personne ne le désigne plus.
const NearestReservationRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
  rideId: z.string().min(1),
  clientUserId: z.string().min(1),
  origin: z.object({ latitude: z.number(), longitude: z.number() }),
  destination: z.object({ latitude: z.number(), longitude: z.number() }),
  amount: z.number(),
  distanceMeters: z.number(),
  // D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1) : Odoo le connaît déjà
  // (client_user.partner_id.phone), transmis ici au même titre qu'origin/destination/amount --
  // évite un appel Odoo supplémentaire depuis ce service au moment de l'affectation (voir
  // proposal/lifecycle.ts::accept). `.nullable()` : rien ne garantit qu'un client a un numéro
  // renseigné.
  clientPhoneNumber: z.string().nullable(),
  // Indication du client (`CreateRideRequest.pickupNote`) -- facultative pour rester compatible
  // avec un Odoo qui ne l'envoie pas encore.
  pickupNote: z.string().max(140).nullable().default(null),
  radiusMeters: z.number().positive(),
  excludeDriverIds: z.array(z.string().min(1)).default([]),
  // Classement par distance ROUTIÈRE (Odoo, services/approach.py) : essayé d'abord, dans l'ordre,
  // puis repli sur le vol d'oiseau. Absent ou vide : vol d'oiseau seul (Odoo antérieur, ou
  // routage indisponible).
  preferredDriverIds: z.array(z.string().min(1)).default([]),
});

// Lecture seule : les chauffeurs disponibles les plus proches à vol d'oiseau, avec leur position,
// pour qu'Odoo mesure leur distance ROUTIÈRE jusqu'au point de prise en charge -- à l'estimation
// (prise en charge moyenne) et avant la réservation (classement). N'écrit rien dans Redis hors du
// nettoyage paresseux de findNearby (retrait d'un chauffeur sans position fraîche) : aucun commit
// à attendre (D32), même exception assumée que /internal/rides/measurement.
const NearbyDriversRequestSchema = z.object({
  origin: z.object({ latitude: z.number(), longitude: z.number() }),
  radiusMeters: z.number().positive(),
  limit: z.number().int().positive(),
  excludeDriverIds: z.array(z.string().min(1)).default([]),
});

export type NearestReservationOutcome =
  | { outcome: 'PROPOSED'; driverId: string; expiresAt: string }
  | { outcome: 'NO_DRIVER_AVAILABLE' };

const RideUnmatchedRequestSchema = z.object({
  rideId: z.string().min(1),
  clientUserId: z.string().min(1),
});

const ReleaseRequestSchema = z.object({ driverId: z.string().min(1) });
const ClearEngagementRequestSchema = z.object({ driverId: z.string().min(1) });
const CashBlockedRequestSchema = z.object({ driverId: z.string().min(1) });
const CashUnblockedRequestSchema = z.object({ driverId: z.string().min(1) });
const DriverUnavailableRequestSchema = z.object({ driverId: z.string().min(1) });
const DriverAvailableRequestSchema = z.object({ driverId: z.string().min(1) });

// L3-19 : rideId/clientUserId/driverId transmis directement par Odoo, qui les connaît déjà
// (babana.ride.client_id/driver_id) -- pas une lecture de tracking/session.ts, qui introduirait
// une dépendance d'ordre avec /internal/engagement/clear (même requête HTTP côté Odoo, voir
// controllers/ride.py::_complete_ride) sans rien apporter.
const RideArrivedRequestSchema = z.object({
  rideId: z.string().min(1),
  clientUserId: z.string().min(1),
  driverId: z.string().min(1),
  arrivedAt: z.string().min(1),
  noShowGraceSeconds: z.number().int().positive(),
});

const RideStartedRequestSchema = z.object({
  rideId: z.string().min(1),
  clientUserId: z.string().min(1),
  driverId: z.string().min(1),
});

const RideMeasurementRequestSchema = z.object({ driverId: z.string().min(1) });

const RideCompletedRequestSchema = z.object({
  rideId: z.string().min(1),
  clientUserId: z.string().min(1),
  driverId: z.string().min(1),
  // J24 (amoa/questions/L6-13.md) : `null` -- jamais 0 -- quand la course s'est terminée sans
  // accumulation temps réel (L3-10). `measured` le dit ; `ride.completed` le transmet tel quel
  // au résumé de fin (D30, D43).
  measured: z.boolean(),
  distanceMeters: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  amount: z.number(),
  // Réutilise le schéma du contrat (D17) -- une seule définition du détail décomposé, celle que
  // `ride.completed` (server-to-client.ts) exporte déjà.
  breakdown: httpContract.FareBreakdownSchema,
});

// L4-12 : notifyClientUserId/notifyDriverId sont chacun optionnels et indépendants (nullable) --
// Odoo (action_cancel) décide déjà qui prévenir selon l'acteur, ce schéma ne fait que porter sa
// décision, jamais la recalculer.
const RideCancelledRequestSchema = z.object({
  rideId: z.string().min(1),
  cancelledBy: z.enum(['client', 'driver', 'supervisor']),
  reason: z.string().max(280).optional(),
  notifyClientUserId: z.string().min(1).nullable().optional(),
  notifyDriverId: z.string().min(1).nullable().optional(),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleNearestReservation(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = NearestReservationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  // Même piège du rejeu qu'au-dessus (D25) : Odoo rejoue la requête entière sur conflit de
  // sérialisation -- la clé rejoue le chauffeur déjà choisi au lieu d'en réserver un second.
  const outcome = await withIdempotency<NearestReservationOutcome>(
    deps.redis,
    body.idempotencyKey,
    deps.config.RESERVATION_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      const details: ProposalDetails = {
        rideId: body.rideId,
        clientUserId: body.clientUserId,
        origin: body.origin,
        destination: body.destination,
        amount: body.amount,
        distanceMeters: body.distanceMeters,
        clientPhoneNumber: body.clientPhoneNumber,
        pickupNote: body.pickupNote,
      };
      const proposed = await deps.proposals.proposeNearest(details, {
        radiusMeters: body.radiusMeters,
        excludeDriverIds: body.excludeDriverIds,
        preferredDriverIds: body.preferredDriverIds,
      });
      return proposed.proposed
        ? { outcome: 'PROPOSED', driverId: proposed.driverId, expiresAt: proposed.expiresAt }
        : { outcome: 'NO_DRIVER_AVAILABLE' };
    },
    (result) => result.outcome === 'PROPOSED'
  );

  sendJson(res, 200, outcome);
}

async function handleNearbyDrivers(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = NearbyDriversRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const { origin, radiusMeters, limit, excludeDriverIds } = parsed.data;
  const excluded = new Set(excludeDriverIds);
  // Sur-demande du nombre d'écartés : la limite porte sur les candidats utilisables.
  const nearby = await findNearby(deps.redis, origin, radiusMeters, limit + excluded.size);
  const drivers = nearby
    .filter((driver) => !excluded.has(driver.driverId))
    .slice(0, limit)
    .map(({ driverId, latitude, longitude, distanceMeters }) => ({ driverId, latitude, longitude, distanceMeters }));
  sendJson(res, 200, { drivers });
}

async function handleRideUnmatched(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = RideUnmatchedRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  broadcastRideUnmatched(deps.registry, parsed.data);
  sendJson(res, 200, { notified: true });
}

async function handleRelease(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = ReleaseRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  await deps.proposals.cancel(parsed.data.driverId);
  sendJson(res, 200, { released: true });
}

async function handleClearEngagement(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = ClearEngagementRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const { driverId } = parsed.data;
  await clearEngaged(deps.redis, driverId);
  // L3-09 : le suivi cesse à la fin de la course (spécification, critère 4) -- même geste que
  // l'effacement de l'engagement, appelé pour la même raison (fin de course OU annulation,
  // notify_cancellation_async côté Odoo appelle aussi ce point).
  await endRideSessionForDriver(deps.redis, driverId);
  // L3-10 : l'accumulation a déjà été lue par Odoo (POST /internal/rides/measurement, avant la
  // transition) -- ici elle n'a plus de raison d'être. Même signal pour fin de course ET
  // annulation : dans les deux cas le trajet est clos.
  await endAccumulation(deps.redis, driverId);
  await reintegrateIfEligible(deps.redis, driverId);
  sendJson(res, 200, { cleared: true });
}

async function handleCashBlocked(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = CashBlockedRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  await blockForCash(deps.redis, parsed.data.driverId);
  sendJson(res, 200, { blocked: true });
}

async function handleCashUnblocked(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = CashUnblockedRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const { driverId } = parsed.data;
  await unblockForCash(deps.redis, driverId);
  await reintegrateIfEligible(deps.redis, driverId);
  sendJson(res, 200, { unblocked: true });
}

async function handleDriverUnavailable(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = DriverUnavailableRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  await holdDriver(deps.redis, parsed.data.driverId);
  sendJson(res, 200, { held: true });
}

async function handleDriverAvailable(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = DriverAvailableRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  // Pas de `reintegrateIfEligible` ici, contrairement à `handleCashUnblocked` (J33, prompt) :
  // lever la non-habilitation ne recrée pas une disponibilité -- le chauffeur se redéclare en
  // ligne lui-même via `availability.set`.
  await releaseHold(deps.redis, parsed.data.driverId);
  sendJson(res, 200, { released: true });
}

async function handleRideStarted(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = RideStartedRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  broadcastRideStarted(deps.registry, parsed.data);
  // L3-10 : « Depuis ride.start, accumuler dans Redis » -- l'accumulation distance/durée/tracé
  // commence ici, au commit de action_start (D32). Restart-safe : tout l'état vit dans Redis.
  await startAccumulation(deps.redis, parsed.data.driverId, deps.config.ACCUMULATION_TTL_SECONDS);
  sendJson(res, 200, { notified: true });
}

async function handleRideMeasurement(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = RideMeasurementRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const measurement = await getAccumulation(deps.redis, parsed.data.driverId);
  // J25 (amoa/questions/REPONSES-2026-09-02.md §3) : une accumulation qui existe (ride.start a
  // posé le HASH) mais n'a encore reçu aucune position n'est pas une mesure de zéro, c'est une
  // absence de mesure -- `pointCount === 0` le distingue. `measurement !== null` seul disait
  // "true" dès ride.start, avant la moindre position : `distanceMeters: 0` avec l'aplomb d'un
  // fait mesuré, jamais démenti tant qu'aucun tracé n'existait vraiment.
  const measured = measurement !== null && measurement.pointCount > 0;
  sendJson(res, 200, {
    measured,
    distanceMeters: measured ? (measurement as NonNullable<typeof measurement>).distanceMeters : null,
    durationSeconds: measured ? (measurement as NonNullable<typeof measurement>).durationSeconds : null,
    polyline: measured ? (measurement as NonNullable<typeof measurement>).polyline : null,
  });
}

async function handleRideCompleted(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = RideCompletedRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  broadcastRideCompleted(deps.registry, parsed.data);
  sendJson(res, 200, { notified: true });
}

async function handleRideCancelled(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = RideCancelledRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  broadcastRideCancelled(deps.registry, parsed.data);
  sendJson(res, 200, { notified: true });
}

export function createInternalHandler(deps: InternalRouterDeps) {
  return async function handleInternal(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const secret = req.headers['x-realtime-secret'];
    if (secret !== deps.config.REALTIME_SHARED_SECRET) {
      sendJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'INVALID_JSON' });
      return;
    }

    switch (pathname) {
      case '/internal/reservations/nearest':
        await handleNearestReservation(deps, body, res);
        return;
      case '/internal/drivers/nearby':
        await handleNearbyDrivers(deps, body, res);
        return;
      case '/internal/rides/unmatched':
        await handleRideUnmatched(deps, body, res);
        return;
      case '/internal/reservations/release':
        await handleRelease(deps, body, res);
        return;
      case '/internal/engagement/clear':
        await handleClearEngagement(deps, body, res);
        return;
      case '/internal/drivers/cash-blocked':
        await handleCashBlocked(deps, body, res);
        return;
      case '/internal/drivers/cash-unblocked':
        await handleCashUnblocked(deps, body, res);
        return;
      case '/internal/drivers/unavailable':
        await handleDriverUnavailable(deps, body, res);
        return;
      case '/internal/drivers/available':
        await handleDriverAvailable(deps, body, res);
        return;
      case '/internal/rides/arrived': {
        // « Sur place » (au commit de action_mark_arrived, D32) : garde l'arrivée et la pousse
        // au client et au chauffeur (tracking/route.ts::recordDriverArrived).
        const parsed = RideArrivedRequestSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: 'VALIDATION_ERROR' });
          return;
        }
        await recordDriverArrived(deps.redis, deps.config, deps.registry, parsed.data);
        sendJson(res, 200, { ok: true });
        return;
      }
      case '/internal/rides/started':
        await handleRideStarted(deps, body, res);
        return;
      case '/internal/rides/measurement':
        await handleRideMeasurement(deps, body, res);
        return;
      case '/internal/rides/completed':
        await handleRideCompleted(deps, body, res);
        return;
      case '/internal/rides/cancelled':
        await handleRideCancelled(deps, body, res);
        return;
      default:
        sendJson(res, 404, { error: 'NOT_FOUND' });
    }
  };
}
