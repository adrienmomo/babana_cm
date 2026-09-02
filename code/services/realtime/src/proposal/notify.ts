import type { Config } from '../config';
import { callOdoo } from '../odoo/client';

/**
 * Notification push de proposition (L7-04) : « la notification la plus critique du système -- une
 * proposition manquée est une course perdue et un délai d'attente pour le client ». Émise EN
 * PARALLÈLE de `proposal.new` par `proposal/lifecycle.ts::propose` (jamais à sa place, critère 1).
 *
 * Ce service n'a pas de canal push à lui, et ne doit pas en avoir : pas de client PostgreSQL
 * (invariant 1), donc pas la table des jetons d'appareil (`babana.device.token`, L7-01) ; pas de
 * SDK Firebase non plus. Il délègue à Odoo, qui porte déjà l'**unique** émetteur FCM
 * (`services/push.py`) et le cycle de vie des jetons. Sens temps réel -> Odoo, même transport et
 * même secret partagé que `odoo/rides.ts` (`reportDriverAccepted`).
 *
 * Non bloquant, exactement comme `reportDriverAccepted` : la résolution atomique côté Redis et
 * l'émission WebSocket font déjà foi pour un chauffeur connecté ; un envoi lent ou en échec ne
 * doit jamais retarder la réservation ni l'émission. Une notification perdue ne bloque aucun
 * parcours -- la relecture d'état à l'ouverture est le filet (L7-06), et `session.synced`
 * (`activeProposal`) restitue la proposition qu'aucun `proposal.new` n'a atteinte.
 *
 * La part **native** (recevoir réellement le message FCM dans `apps/driver`) rejoint la passe
 * avec appareil (L6-19), comme le sélecteur de pièces et le service de premier plan : elle exige
 * un binding natif et un build mobile que cet environnement ne produit pas. La logique de routage
 * et de déduplication, elle, s'écrit et se teste ici (`apps/driver/src/push/handlers.ts`).
 */

export interface ProposalNotifyParams {
  driverId: string;
  rideId: string;
  /** Véritable échéance d'acceptation, portée telle quelle jusqu'au contenu de la notification --
   * « une course est proposée, avec le temps restant » (spécification, contenu minimal). */
  expiresAt: string;
}

export type ProposalNotifier = (config: Config, params: ProposalNotifyParams) => void;

export const notifyDriverOfProposal: ProposalNotifier = (config, params) => {
  callOdoo(config, '/api/internal/drivers/proposal-push', {
    driverId: params.driverId,
    rideId: params.rideId,
    expiresAt: params.expiresAt,
  }).catch((err: unknown) => {
    console.error(
      `[L7-04] échec de la notification push de proposition (chauffeur ${params.driverId}, course ${params.rideId}) -- ` +
        'le message WebSocket reste le canal principal, la relecture d’état à l’ouverture est le filet (L7-06) :',
      err
    );
  });
};
