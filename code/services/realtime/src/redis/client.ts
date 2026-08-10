import Redis from 'ioredis';
import type { Config } from '../config';

/**
 * ioredis : reconnexion automatique intégrée, nécessaire pour un service qui doit survivre à
 * une coupure Redis sans intervention (invariant 1 -- aucune donnée durable ici, donc perdre la
 * connexion un instant ne perd jamais une course confirmée, seulement l'état éphémère en cours).
 */
export function createRedisClient(config: Config): Redis {
  return new Redis(config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
}

export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    const reply = await client.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
