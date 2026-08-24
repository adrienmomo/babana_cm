import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import type { Config } from '../config';
import { resolveShare } from '../odoo/share';
import { getRideSession } from '../tracking/session';
import { getPosition } from '../redis/positions';
import { haversineDistanceMeters } from '../tracking/validation';
import { renderSharePage, renderShareNotFoundPage } from './page';
import { ShareRateLimiter } from './rateLimit';

/**
 * Partage de trajet (L8-03) : `GET /s/{token}` (la page) et `GET /s/{token}/status` (le JSON
 * qu'elle interroge en boucle). Servi depuis l'apex par Caddy (infra/caddy/Caddyfile, déjà en
 * place -- `handle /s/* { reverse_proxy realtime:3000 }`), jamais authentifié : c'est le jeton
 * lui-même, opaque et non devinable, qui tient lieu d'autorisation (spécification, critère 1).
 *
 * `origin` (point de rendez-vous pendant l'approche) vient de Redis (`tracking/session.ts`),
 * jamais d'Odoo -- c'est la même donnée éphémère que `ride.track` (L3-09) lit déjà pour le
 * suivi côté app, pas une seconde source. `destination` vient d'Odoo (`odoo/share.ts`), seule
 * source qui la connaisse (invariant 1 : ce service ne garde aucune donnée durable).
 */

export interface ShareStatus {
  active: boolean;
  phase?: 'approach' | 'course';
  driverFirstName?: string | null;
  motorcycleClass?: 'standard' | 'premium' | null;
  position?: { latitude: number; longitude: number } | null;
  target?: { latitude: number; longitude: number } | null;
  etaSeconds?: number | null;
}

export function isSharePath(pathname: string): boolean {
  return pathname === '/s' || pathname.startsWith('/s/');
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function createShareHandler(config: Config, redis: Redis) {
  const rateLimiter = new ShareRateLimiter(config);

  async function buildStatus(token: string): Promise<ShareStatus> {
    const resolved = await resolveShare(config, token);
    if (!resolved.active || !resolved.rideId || !resolved.destination) return { active: false };

    const session = await getRideSession(redis, resolved.rideId);
    const position = session ? await getPosition(redis, session.driverId) : null;
    const phase = resolved.phase ?? 'approach';
    const target = phase === 'course' ? resolved.destination : session?.origin ?? resolved.destination;

    let etaSeconds: number | null = null;
    if (phase === 'approach' && position && session) {
      const distanceMeters = haversineDistanceMeters(position, session.origin);
      etaSeconds = Math.round(distanceMeters / config.TRACKING_AVERAGE_SPEED_MPS);
    }

    return {
      active: true,
      phase,
      driverFirstName: resolved.driverFirstName ?? null,
      motorcycleClass: resolved.motorcycleClass ?? null,
      position: position ? { latitude: position.latitude, longitude: position.longitude } : null,
      target,
      etaSeconds,
    };
  }

  return async function handleShareRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    const rest = pathname.slice('/s/'.length).replace(/\/+$/, '');
    const segments = rest.split('/').filter(Boolean);
    const token = segments[0];
    const wantsStatus = segments[1] === 'status' && segments.length === 2;
    if (!token || segments.length > 2 || (segments.length === 2 && !wantsStatus)) {
      sendHtml(res, 404, renderShareNotFoundPage());
      return;
    }

    const rateLimit = rateLimiter.allow(token);
    if (!rateLimit.allowed) {
      sendJson(res, 429, { error: 'RATE_LIMITED' }, {
        'Retry-After': String(Math.ceil(rateLimit.retryAfterMs / 1000)),
      });
      return;
    }

    if (wantsStatus) {
      const status = await buildStatus(token);
      sendJson(res, 200, status);
      return;
    }

    const resolved = await resolveShare(config, token);
    sendHtml(
      res,
      200,
      renderSharePage({
        token,
        pollIntervalSeconds: config.SHARE_POLL_INTERVAL_SECONDS,
        initialActive: resolved.active,
      })
    );
  };
}
