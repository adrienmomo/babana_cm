import type Redis from 'ioredis';
import { http } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { callOdoo } from './client';
import { reportOutboxWrite } from './outbox';

/**
 * Sens temps réel -> Odoo pour l'acceptation, le refus et l'expiration (L3-17). Volontairement
 * *non bloquant* pour l'appelant (`proposal/lifecycle.ts`) : la résolution atomique côté Redis
 * (`resolve.lua`) a déjà eu lieu et fait foi pour le chauffeur et pour le client, connectés en
 * temps réel -- les faire attendre un aller-retour HTTP vers Odoo avant de recevoir
 * `ride.assigned`/`ride.rejected` ajouterait une latence perceptible pour un bénéfice qui n'est
 * pas le leur.
 *
 * **L3-12, comblé le 3 septembre** : l'écriture ne part plus par `callOdoo` (trois réessais EN
 * MÉMOIRE, perdus si le service redémarre) mais par la file persistante `odoo/outbox.ts` --
 * `reportOutboxWrite` persiste l'entrée dans Redis avant toute tentative, puis en tente une tout
 * de suite (même latence que l'ancien comportement dans le cas courant, Odoo joignable). Si
 * l'appel échoue durablement, l'entrée reste en file et le passage périodique la reprend avec un
 * délai croissant, y compris après un redémarrage du service (amoa/questions/L3-17.md §1 : un
 * refus dont l'appel Odoo échouait laissait jusqu'ici la course bloquée en `proposed` pour
 * toujours, `action_propose` n'acceptant que `requested`/`rejected` en état source).
 *
 * Ce découplage est la même idée que l'option "sortir l'appel de la transaction rejouable" du
 * piège de select-driver (voir http/internal.ts), appliquée ici à un appel qui n'a de toute façon
 * jamais lieu dans une transaction Odoo rejouable -- c'est un appel SORTANT de ce service, initié
 * par un message WebSocket, jamais par un contrôleur Odoo.
 */
export function reportDriverAccepted(
  config: Config,
  redis: Redis,
  rideId: string,
  driverId: string
): void {
  reportOutboxWrite(
    config,
    redis,
    'driver-accepted',
    `/api/internal/rides/${encodeURIComponent(rideId)}/driver-accepted`,
    { driverId }
  );
}

export interface DriverRejectedOptions {
  reason?: string | null;
  expired: boolean;
}

export function reportDriverRejected(
  config: Config,
  redis: Redis,
  rideId: string,
  driverId: string,
  options: DriverRejectedOptions
): void {
  reportOutboxWrite(
    config,
    redis,
    'driver-rejected',
    `/api/internal/rides/${encodeURIComponent(rideId)}/driver-rejected`,
    { driverId, reason: options.reason ?? null, expired: options.expired }
  );
}

export interface EngagedDriver {
  driverId: string;
  rideId: string;
}

/**
 * Sens Odoo -> temps réel n'est PAS celui-ci : cette fonction, elle, lit Odoo (réconciliation,
 * `driver/reconcile.ts`). Bloquante pour son appelant, à la différence des deux fonctions
 * ci-dessus -- la réconciliation a besoin du résultat pour décider quoi aligner, pas d'un effet de
 * bord à ne pas attendre.
 *
 * Porte `rideId` avec chaque chauffeur (D44, amoa/questions/REPONSES-2026-08-28.md §3) : un
 * engagement réparé sans identifiant de course produit, depuis l'unification de l'état Redis
 * (L3-18), un état qu'aucune transition normale ne peut produire -- engagé, sans suivi possible.
 * Odoo connaît cet identifiant (une seule course active par chauffeur), la réponse le porte donc
 * pour que `driver/reconcile.ts` puisse l'écrire.
 */
export async function fetchEngagedDrivers(config: Config): Promise<EngagedDriver[]> {
  const result = await callOdoo(config, '/api/internal/drivers/engaged', {});
  const body = result as { engaged?: unknown };
  if (!Array.isArray(body.engaged)) return [];
  return body.engaged.filter(
    (entry): entry is EngagedDriver =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as EngagedDriver).driverId === 'string' &&
      typeof (entry as EngagedDriver).rideId === 'string'
  );
}

export interface ActiveRide {
  rideId: string | null;
  state: http.RideState | null;
}

/**
 * Sens Odoo -> temps réel, comme `fetchEngagedDriverIds` ci-dessus : bloquante pour son
 * appelant (`ws/resync.ts`, L3-11), qui a besoin du résultat pour répondre à `session.resync`.
 * Odoo est la source de vérité (D27) -- le service temps réel ne garde aucune trace durable de
 * l'état d'une course (invariant 1), donc rien à lire dans Redis pour cette réponse.
 */
export async function fetchActiveRide(
  config: Config,
  context: Pick<ConnectionContext, 'userId' | 'role'>,
  lastKnownRideId: string | null
): Promise<ActiveRide> {
  const result = await callOdoo(config, '/api/internal/session/active-ride', {
    userId: context.userId,
    role: context.role,
    lastKnownRideId,
  });
  const body = result as { rideId?: unknown; state?: unknown };
  return {
    rideId: typeof body.rideId === 'string' ? body.rideId : null,
    state: typeof body.state === 'string' ? (body.state as http.RideState) : null,
  };
}
