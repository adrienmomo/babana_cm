import http, { type Server } from 'node:http';
import type Redis from 'ioredis';
import type { Config } from './config';
import { pingRedis } from './redis/client';
import { pingOdoo } from './odoo/client';
import { createConnectionHandler } from './ws/connection';
import { createInternalHandler, isInternalPath } from './http/internal';

/**
 * /health (nu) : vérifié directement par le healthcheck Docker, sans passer par Caddy
 * (infra/compose.yaml). /rt/health (préfixé) : chemin public à travers Caddy (handle /rt/* sans
 * réécriture de préfixe, infra/caddy/Caddyfile) -- même convention que le squelette de L0-01,
 * reprise ici pour de bon. /rt/ws : la connexion WebSocket, publique via Caddy, prefix identique.
 */
async function computeHealth(config: Config, redis: Redis) {
  const [redisOk, odooOk] = await Promise.all([pingRedis(redis), pingOdoo(config)]);
  return {
    ok: redisOk && odooOk,
    dependencies: {
      redis: redisOk ? 'ok' : 'unreachable',
      odoo: odooOk ? 'ok' : 'unreachable',
    },
  };
}

export function createServer(config: Config, redis: Redis): Server {
  const { wss, proposals } = createConnectionHandler(config, redis);
  // Même instance que celle qui traite proposal.accept/proposal.reject côté WebSocket
  // (ws/connection.ts) -- /internal/reservations doit poser sa proposition sur les mêmes
  // minuteurs et le même registre de connexions, pas sur une seconde instance isolée.
  const internal = createInternalHandler({ config, redis, proposals });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://internal');

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/rt/health')) {
      computeHealth(config, redis)
        .then((health) => {
          res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        })
        .catch(() => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, dependencies: { redis: 'unknown', odoo: 'unknown' } }));
        });
      return;
    }

    // Jamais public (spécification L3-17) : servi ici, mais Caddy (infra/caddy/Caddyfile) ne
    // route jamais vers ce préfixe depuis l'extérieur -- seuls /rt/* et /s/* le sont.
    if (isInternalPath(url.pathname)) {
      internal(req, res, url.pathname).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://internal');
    if (url.pathname !== '/rt/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  return server;
}
