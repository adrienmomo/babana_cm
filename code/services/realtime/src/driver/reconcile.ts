import type Redis from 'ioredis';
import type { Config } from '../config';
import { fetchEngagedDriverIds } from '../odoo/rides';
import { reintegrateIfEligible } from '../redis/pool-eligibility';
import { setEngaged, clearEngaged } from './engagement';
import { removeFromPool } from '../redis/geo-index';
import { scanEngagedDriverIds } from '../ride/state';

/**
 * Réconciliation des marqueurs d'engagement contre Odoo (L3-17). Le marqueur n'expire jamais tout
 * seul, délibérément (D26, L3-06/L3-07) : un embouteillage à Douala ne doit pas remettre au pool
 * un chauffeur qui transporte un client. Mais un marqueur qui n'expire jamais est un marqueur
 * qu'un seul échec (appel Odoo perdu, redémarrage au mauvais moment, exception avalée) laisse en
 * place POUR TOUJOURS -- le chauffeur continue d'émettre ses positions, son application lui dit
 * qu'il est en ligne, et il ne reçoit plus jamais une seule course. C'est le scénario du contexte
 * terrain de CLAUDE.md, avec une clé Redis pour cause.
 *
 * Odoo est la source de vérité (D27) ; ce module ne décide de rien, il reflète (invariant 3) :
 * il efface les marqueurs orphelins (posés côté Redis, sans course active côté Odoo) et pose ceux
 * qui manquent (course active côté Odoo, sans marqueur côté Redis -- le cas d'une acceptation dont
 * l'appel `reportDriverAccepted` n'a jamais atteint Odoo).
 *
 * **L'écart constaté à chaque passage est compté et journalisé.** Un écart durablement non nul
 * n'est pas un incident de réconciliation, c'est un défaut du chemin nominal -- la réconciliation
 * le répare ET le dénonce, elle ne le masque jamais.
 */

export interface ReconcileResult {
  orphansCleared: string[];
  markersSet: string[];
}

export async function reconcileEngagement(config: Config, redis: Redis): Promise<ReconcileResult> {
  // scanEngagedDriverIds : ride/state.ts (L3-18) -- balaie l'état unifié et filtre sur
  // state === 'engaged', remplace l'ancien balayage direct de ENGAGEMENT_KEY_PREFIX.
  const [odooEngaged, redisEngaged] = await Promise.all([
    fetchEngagedDriverIds(config).then((ids) => new Set(ids)),
    scanEngagedDriverIds(redis),
  ]);

  const orphans = [...redisEngaged].filter((driverId) => !odooEngaged.has(driverId));
  const missing = [...odooEngaged].filter((driverId) => !redisEngaged.has(driverId));

  await Promise.all(
    orphans.map(async (driverId) => {
      await clearEngaged(redis, driverId);
      await reintegrateIfEligible(redis, driverId);
    })
  );
  await Promise.all(
    missing.map(async (driverId) => {
      // Retiré du pool D'ABORD : la fenêtre entre les deux appels ne doit jamais laisser un
      // chauffeur qu'Odoo dit engagé apparaître, même un instant, comme disponible.
      await removeFromPool(redis, driverId);
      await setEngaged(redis, driverId);
    })
  );

  if (orphans.length > 0 || missing.length > 0) {
    // Journalisé, pas seulement corrigé (spécification L3-17) : un écart durablement non nul est
    // un défaut du chemin nominal (l'appel Odoo -> temps réel non bloquant de proposal/lifecycle.ts
    // qui échoue plus souvent que ses réessais ne l'absorbent), pas un simple incident isolé.
    console.warn(
      `[L3-17] réconciliation engagement : ${orphans.length} orphelin(s) effacé(s), ` +
        `${missing.length} marqueur(s) manquant(s) posé(s)`,
      { orphans, missing }
    );
  }

  return { orphansCleared: orphans, markersSet: missing };
}

/**
 * Démarre la réconciliation périodique (appelé une fois depuis index.ts, même patron que
 * `startReservationExpiryWatcher`). `unref()` : ne doit jamais empêcher un arrêt propre du
 * processus.
 */
export function startEngagementReconciliation(config: Config, redis: Redis): () => void {
  const timer = setInterval(() => {
    reconcileEngagement(config, redis).catch((err: unknown) => {
      // Une panne Odoo ou Redis passagère ici ne doit jamais faire planter le service -- au pire,
      // le passage suivant corrigera l'écart.
      console.error('[L3-17] échec du passage de réconciliation engagement :', err);
    });
  }, config.ENGAGEMENT_RECONCILE_INTERVAL_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
