import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import { z } from 'zod';
import type { Config } from '../config';
import type { ProposalLifecycle, ProposalDetails } from '../proposal/lifecycle';
import { wasRecentlySent } from '../nearby/last-sent';
import { withIdempotency } from '../reservation/idempotency';
import { clearEngaged } from '../driver/engagement';
import { reintegrateIfEligible } from '../redis/pool-eligibility';

/**
 * Endpoint HTTP interne, sens Odoo -> temps réel (L3-17). Authentifié par `REALTIME_SHARED_SECRET`
 * (même secret, même mécanisme que le sens sortant de L3-12/L3-15 -- pas un second à inventer),
 * **jamais exposé publiquement** : Caddy ne route jamais vers `/internal/*` depuis l'extérieur
 * (infra/caddy/Caddyfile ne sert que `/rt/*`), et le secret est une seconde barrière, indépendante
 * du routage -- défense en profondeur, pas un unique point de défaillance.
 *
 * Trois routes :
 * - `POST /internal/reservations` : réserve et propose (select-driver, avant la transition Odoo).
 *   Idempotent (critère 3, le piège central de la tâche -- voir reservation/idempotency.ts) et
 *   vérifie la précondition C-03 (chauffeur présent dans la dernière liste des 5, critère 8).
 * - `POST /internal/reservations/release` : compensation quand la réservation a réussi mais que la
 *   transition Odoo qui devait suivre échoue (critère 4).
 * - `POST /internal/engagement/clear` : fin de course, efface le marqueur d'engagement (critère 6).
 */

export const INTERNAL_PATH_PREFIX = '/internal/';

export function isInternalPath(pathname: string): boolean {
  return pathname.startsWith(INTERNAL_PATH_PREFIX);
}

export interface InternalRouterDeps {
  config: Config;
  redis: Redis;
  proposals: ProposalLifecycle;
}

const ReservationRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
  rideId: z.string().min(1),
  driverId: z.string().min(1),
  clientUserId: z.string().min(1),
  origin: z.object({ latitude: z.number(), longitude: z.number() }),
  destination: z.object({ latitude: z.number(), longitude: z.number() }),
  amount: z.number(),
  distanceMeters: z.number(),
});

export type ReservationOutcome =
  | { outcome: 'PROPOSED'; expiresAt: string }
  | { outcome: 'DRIVER_ALREADY_TAKEN' }
  | { outcome: 'DRIVER_NOT_IN_LAST_LIST' };

const ReleaseRequestSchema = z.object({ driverId: z.string().min(1) });
const ClearEngagementRequestSchema = z.object({ driverId: z.string().min(1) });

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

async function handleReservation(deps: InternalRouterDeps, rawBody: unknown, res: ServerResponse): Promise<void> {
  const parsed = ReservationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  const outcome = await withIdempotency<ReservationOutcome>(
    deps.redis,
    body.idempotencyKey,
    deps.config.RESERVATION_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      // Précondition C-03 (critère 8), vérifiée AVANT toute réservation -- un chauffeur jamais
      // montré à ce client ne doit même pas être tenté, pour ne rien avoir à défaire ensuite.
      const eligible = await wasRecentlySent(deps.redis, body.clientUserId, body.driverId);
      if (!eligible) {
        return { outcome: 'DRIVER_NOT_IN_LAST_LIST' };
      }

      const details: ProposalDetails = {
        rideId: body.rideId,
        clientUserId: body.clientUserId,
        origin: body.origin,
        destination: body.destination,
        amount: body.amount,
        distanceMeters: body.distanceMeters,
      };
      const proposeOutcome = await deps.proposals.propose(body.driverId, details);
      if (!proposeOutcome.proposed) {
        return { outcome: 'DRIVER_ALREADY_TAKEN' };
      }
      return { outcome: 'PROPOSED', expiresAt: proposeOutcome.expiresAt };
    }
  );

  sendJson(res, 200, outcome);
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
  await reintegrateIfEligible(deps.redis, driverId);
  sendJson(res, 200, { cleared: true });
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
      case '/internal/reservations':
        await handleReservation(deps, body, res);
        return;
      case '/internal/reservations/release':
        await handleRelease(deps, body, res);
        return;
      case '/internal/engagement/clear':
        await handleClearEngagement(deps, body, res);
        return;
      default:
        sendJson(res, 404, { error: 'NOT_FOUND' });
    }
  };
}
