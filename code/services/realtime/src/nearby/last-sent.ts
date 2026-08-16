import type Redis from 'ioredis';

/**
 * Mémorise, par client, les identifiants de chauffeur envoyés au dernier `nearby.drivers` (L3-17,
 * précondition C-03 : "chauffeur présent dans la dernière liste des 5" -- signalée depuis L3-06,
 * jamais vérifiée nulle part avant cette tâche, qui est la première où les deux côtés se parlent).
 *
 * Sans elle, un client pourrait sélectionner n'importe quel `driverId` -- y compris un identifiant
 * jamais affiché, deviné ou intercepté -- puisque `reserve.lua` ne vérifie que la présence dans le
 * pool, pas l'autorisation du client à le voir.
 */

const LAST_SENT_KEY_PREFIX = 'babana:nearby:lastsent:';

function lastSentKey(userId: string): string {
  return `${LAST_SENT_KEY_PREFIX}${userId}`;
}

export async function recordLastSent(
  redis: Redis,
  userId: string,
  driverIds: readonly string[],
  ttlSeconds: number
): Promise<void> {
  const key = lastSentKey(userId);
  const multi = redis.multi().del(key);
  if (driverIds.length > 0) multi.sadd(key, ...driverIds);
  multi.expire(key, ttlSeconds);
  await multi.exec();
}

export async function wasRecentlySent(redis: Redis, userId: string, driverId: string): Promise<boolean> {
  return (await redis.sismember(lastSentKey(userId), driverId)) === 1;
}
