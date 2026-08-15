import type Redis from 'ioredis';
import { removeFromPool } from '../redis/geo-index';

/**
 * Bascule en ligne / hors ligne côté temps réel (L3-04, D7). Odoo reste la source de vérité de
 * l'éligibilité (POST /drivers/me/availability, controllers/driver.py) : ce module ne décide de
 * rien, il applique ce que la connexion chauffeur annonce (message `availability.set`, C-02) --
 * invariant 3.
 *
 * Le passage en ligne ne pose ici qu'un drapeau ("ce chauffeur veut être disponible") : il n'a
 * pas forcément de position connue à cet instant, donc pas encore de quoi entrer dans le
 * géo-index (L3-03). C'est `tracking/ingest.ts` qui, à la première position acceptée d'un
 * chauffeur marqué en ligne, l'insère réellement -- L3-02 et L3-04 se rejoignent là plutôt que de
 * dupliquer la décision.
 *
 * Le passage hors ligne, lui, est immédiat et inconditionnel (spécification L3-04) : retire du
 * drapeau ET du géo-index dans la même opération.
 */

const ONLINE_FLAG_PREFIX = 'babana:driver:online:';

function onlineFlagKey(driverId: string): string {
  return `${ONLINE_FLAG_PREFIX}${driverId}`;
}

export async function setOnline(redis: Redis, driverId: string): Promise<void> {
  await redis.set(onlineFlagKey(driverId), '1');
}

export async function setOffline(redis: Redis, driverId: string): Promise<void> {
  await redis.del(onlineFlagKey(driverId));
  await removeFromPool(redis, driverId);
}

export async function isMarkedOnline(redis: Redis, driverId: string): Promise<boolean> {
  return (await redis.exists(onlineFlagKey(driverId))) === 1;
}

/**
 * Minuteurs de période de grâce après déconnexion réseau, un par chauffeur (critère
 * d'acceptation 3) : une coupure ne met pas hors ligne immédiatement -- le réseau mobile
 * intermittent à Douala est le cas courant, pas un cas limite (CLAUDE.md). Si le chauffeur ne se
 * reconnecte pas avant l'expiration, `setOffline` s'applique ; une reconnexion avant l'échéance
 * annule le minuteur (voir `cancel`, appelé par `ws/connection.ts` à l'authentification).
 */
export class DisconnectGraceTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(redis: Redis, driverId: string, graceSeconds: number): void {
    this.cancel(driverId);
    const timer = setTimeout(() => {
      this.timers.delete(driverId);
      setOffline(redis, driverId).catch(() => {
        // Filet défensif : une panne Redis passagère ici ne doit jamais faire planter le
        // service -- au pire, le chauffeur sort du pool un peu plus tard, via l'expiration de
        // sa position (L3-02), qui reste le filet de sécurité ultime.
      });
    }, graceSeconds * 1000);
    // unref() : ce minuteur ne doit jamais empêcher le processus de s'arrêter proprement (même
    // raisonnement que le minuteur d'expiration de jeton, ws/connection.ts).
    timer.unref();
    this.timers.set(driverId, timer);
  }

  cancel(driverId: string): void {
    const timer = this.timers.get(driverId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(driverId);
    }
  }

  has(driverId: string): boolean {
    return this.timers.has(driverId);
  }
}
