import type Redis from 'ioredis';

/**
 * Rejeu de la réponse d'un appel déjà traité, plutôt qu'un nouveau calcul (L3-17, critère 3 --
 * le piège central de la tâche). Odoo rejoue la requête HTTP entière sur conflit de sérialisation
 * PostgreSQL (D25, `odoo.service.model.retrying`) : un appel sortant vers ce service, placé avant
 * la transition Odoo dans un contrôleur rejouable, s'exécute donc deux fois pour une seule action
 * cliente. Sans ce module, la seconde exécution tenterait de réserver le MÊME chauffeur une
 * seconde fois -- `reserve.lua` répondrait alors `DRIVER_ALREADY_TAKEN` à une requête qui avait
 * pourtant déjà réussi, transformant un succès en échec au moment même où Odoo rejoue.
 *
 * `services/realtime_client.py` fournit une clé stable à travers le rejeu d'Odoo : l'identifiant
 * d'idempotence du client si l'app mobile en a fourni un (L4-03), sinon une clé composite
 * course+chauffeur -- les deux stables d'une exécution à l'autre du MÊME rejeu Odoo, puisque ni
 * l'un ni l'autre ne dépend d'un état de base de données que le rejeu remettrait à zéro.
 */
export async function withIdempotency<T>(
  redis: Redis,
  idempotencyKey: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const key = idempotencyRedisKey(idempotencyKey);
  const cached = await redis.get(key);
  if (cached !== null) {
    return JSON.parse(cached) as T;
  }

  const result = await compute();

  // NX : si un appel concurrent a déjà écrit un résultat pour cette même clé entre notre lecture
  // et cette écriture, on ne l'écrase jamais -- l'appelant reçoit quand même le résultat réel de
  // SA propre tentative (celle-ci a eu lieu, avec ses effets de bord), seul le CACHE garde le
  // premier écrivain.
  await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds, 'NX');
  return result;
}

const IDEMPOTENCY_KEY_PREFIX = 'babana:internal:reservations:idempotency:';

function idempotencyRedisKey(key: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${key}`;
}
