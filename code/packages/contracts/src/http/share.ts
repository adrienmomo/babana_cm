import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * Partage de trajet (L8-03, CDC §II.6). Deux endpoints authentifiés, réservés au client
 * (`babana.ride.client_id`) -- créer/reprendre un jeton, le révoquer. La page publique
 * elle-même (`GET https://babana.cm/s/{token}`) n'est pas un endpoint de ce contrat : elle est
 * servie par le service temps réel (`services/realtime/src/share/`), jamais par Odoo
 * directement, et ne porte donc aucun jeton d'authentification applicatif.
 */

export const CreateRideShareResponseSchema = z.object({
  token: z.string().min(1),
  /** URL courte complète, apex jamais sous-domaine (spécification) -- prête à coller dans un
   * SMS ou une conversation WhatsApp telle quelle. */
  url: z.string().url(),
  /** `null` tant que la course est active : l'expiration ne se calcule qu'une fois la course
   * terminée plus le délai de grâce configurable (spécification). */
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type CreateRideShareResponse = z.infer<typeof CreateRideShareResponseSchema>;

export const CreateRideShareErrors = ['RIDE_NOT_FOUND', 'RIDE_NOT_OWNED', 'RIDE_NOT_ACTIVE'] as const;

export const createRideShareResponseExample: CreateRideShareResponse = {
  token: 'nV3k7q2xR8mZpL4wT6yB1cD9fH5jN0sA',
  url: 'https://babana.cm/s/nV3k7q2xR8mZpL4wT6yB1cD9fH5jN0sA',
  expiresAt: null,
};

export const RevokeRideShareResponseSchema = z.object({
  revoked: z.literal(true),
});
export type RevokeRideShareResponse = z.infer<typeof RevokeRideShareResponseSchema>;

export const RevokeRideShareErrors = ['RIDE_NOT_FOUND', 'RIDE_NOT_OWNED'] as const;

export const revokeRideShareResponseExample: RevokeRideShareResponse = {
  revoked: true,
};
