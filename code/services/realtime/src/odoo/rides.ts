import { http } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { callOdoo } from './client';

/**
 * Sens temps réel -> Odoo pour l'acceptation, le refus et l'expiration (L3-17). Volontairement
 * *non bloquant* pour l'appelant (`proposal/lifecycle.ts`) : la résolution atomique côté Redis
 * (`resolve.lua`) a déjà eu lieu et fait foi pour le chauffeur et pour le client, connectés en
 * temps réel -- les faire attendre un aller-retour HTTP vers Odoo avant de recevoir
 * `ride.assigned`/`ride.rejected` ajouterait une latence perceptible pour un bénéfice qui n'est
 * pas le leur. L'écriture Odoo elle-même se fait en tâche de fond, avec les réessais déjà portés
 * par `callOdoo` (L0-04).
 *
 * Ce découplage est la même idée que l'option "sortir l'appel de la transaction rejouable" du
 * piège de select-driver (voir http/internal.ts), appliquée ici à un appel qui n'a de toute façon
 * jamais lieu dans une transaction Odoo rejouable -- c'est un appel SORTANT de ce service, initié
 * par un message WebSocket, jamais par un contrôleur Odoo.
 *
 * **Ce que cette absence de blocage coûte, en connaissance de cause** : si l'appel Odoo échoue
 * durablement (Odoo injoignable plus longtemps que les réessais de `callOdoo`), l'engagement posé
 * côté Redis (accept) ou le retour au pool (reject/expire) reste correct, mais la course Odoo ne
 * transitionne jamais -- jusqu'à ce que la réconciliation (`driver/reconcile.ts`) constate l'écart
 * et l'aligne. C'est précisément ce que L3-12 (file d'attente persistante avec rejeu, hors
 * périmètre de cette tâche -- amoa/questions/L3-17.md) doit fermer pour de bon.
 */
export function reportDriverAccepted(config: Config, rideId: string, driverId: string): void {
  callOdoo(config, `/api/internal/rides/${encodeURIComponent(rideId)}/driver-accepted`, { driverId }).catch(
    (err: unknown) => {
      console.error(
        `[L3-17] échec de la notification d'acceptation à Odoo (ride ${rideId}, chauffeur ${driverId}) -- ` +
          "la réconciliation périodique corrigera l'écart si Odoo ne voit jamais cette transition :",
        err
      );
    }
  );
}

export interface DriverRejectedOptions {
  reason?: string | null;
  expired: boolean;
}

export function reportDriverRejected(
  config: Config,
  rideId: string,
  driverId: string,
  options: DriverRejectedOptions
): void {
  callOdoo(config, `/api/internal/rides/${encodeURIComponent(rideId)}/driver-rejected`, {
    driverId,
    reason: options.reason ?? null,
    expired: options.expired,
  }).catch((err: unknown) => {
    console.error(
      `[L3-17] échec de la notification de refus/expiration à Odoo (ride ${rideId}, chauffeur ${driverId}) :`,
      err
    );
  });
}

/**
 * Sens Odoo -> temps réel n'est PAS celui-ci : cette fonction, elle, lit Odoo (réconciliation,
 * `driver/reconcile.ts`). Bloquante pour son appelant, à la différence des deux fonctions
 * ci-dessus -- la réconciliation a besoin du résultat pour décider quoi aligner, pas d'un effet de
 * bord à ne pas attendre.
 */
export async function fetchEngagedDriverIds(config: Config): Promise<string[]> {
  const result = await callOdoo(config, '/api/internal/drivers/engaged', {});
  const body = result as { driverIds?: unknown };
  if (!Array.isArray(body.driverIds)) return [];
  return body.driverIds.filter((value): value is string => typeof value === 'string');
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
