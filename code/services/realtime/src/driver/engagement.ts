import type Redis from 'ioredis';
import { engagementKey } from './keys';

/**
 * Marqueur d'engagement d'un chauffeur sur une course (L3-07, D26) : état DISTINCT de la
 * réservation (reservation/reserve.ts), posé par `proposal/lifecycle.ts` à l'acceptation, EN
 * REMPLACEMENT de la réservation qu'il efface au même geste (voir `proposal/resolve.lua`).
 *
 * Sans expiration -- une course n'a pas de durée prévisible, un embouteillage à Douala ne doit
 * pas remettre au pool un chauffeur qui transporte un client (amoa/specs/L3-temps-reel.md, L3-06,
 * "Ce n'est pas la réservation qu'il faut rendre atomique, c'est le pool"). C'est précisément le
 * second défaut relevé le 16 août : la réservation expirait en pleine course et le veilleur
 * d'expiration remettait le chauffeur dans le pool, disponible, avec un passager derrière.
 *
 * Effacé uniquement à la fin de course -- hors du périmètre de L3-07, qui pose le marqueur sans
 * jamais encore le retirer : aucune tâche de cette nuit ne traite `ride.complete`. `clearEngaged`
 * est exporté prêt à l'emploi pour cette tâche future.
 */
export async function setEngaged(redis: Redis, driverId: string): Promise<void> {
  await redis.set(engagementKey(driverId), '1');
}

export async function clearEngaged(redis: Redis, driverId: string): Promise<void> {
  await redis.del(engagementKey(driverId));
}

export async function isEngaged(redis: Redis, driverId: string): Promise<boolean> {
  return (await redis.exists(engagementKey(driverId))) === 1;
}
