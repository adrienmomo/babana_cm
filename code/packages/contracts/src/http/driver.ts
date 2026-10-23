import { z } from 'zod';
import { LatLngSchema } from './common';

/**
 * Endpoints chauffeur hors caisse (la caisse vit dans settlement.ts, thématiquement liée à
 * l'encaissement). Fichier non listé explicitement dans l'arborescence de la spécification
 * C-01 (implémentation, voir le message de commit).
 */

/**
 * Chauffeur proche, tel qu'exposé au client. Servi exclusivement par `nearby.drivers` (C-02, flux
 * WebSocket, `packages/contracts/src/realtime/server-to-client.ts::NearbyDriversPayloadSchema`).
 *
 * **Un point anonyme, rien d'autre** (22 octobre) : le serveur choisit le chauffeur le plus proche,
 * le client ne choisit plus -- il n'a donc plus aucune raison de connaître un chauffeur avant que
 * la course lui soit affectée (`ride.assigned`, puis l'historique). Ni identifiant, ni prénom, ni
 * photo, ni note, ni gamme de moto : seulement une position arrondie (garde-fou C2b) et la
 * distance. L'ancienne forme (D14, choix par le client) portait prénom, photo, note et gamme.
 *
 * .strict() : rejeter le surplus, pas seulement valider les champs présents.
 */
export const NearbyDriverSchema = z
  .object({
    /** Position arrondie — précision fixée dans docs/contracts/realtime-events.md (C-02). */
    position: LatLngSchema,
    distanceMeters: z.number().int().nonnegative(),
  })
  .strict();
export type NearbyDriver = z.infer<typeof NearbyDriverSchema>;

/**
 * POST /drivers/me/availability
 * Bascule en ligne / hors ligne (D7).
 */
export const SetAvailabilityRequestSchema = z.object({
  online: z.boolean(),
});
export type SetAvailabilityRequest = z.infer<typeof SetAvailabilityRequestSchema>;

export const SetAvailabilityResponseSchema = z.object({
  online: z.boolean(),
});
export type SetAvailabilityResponse = z.infer<typeof SetAvailabilityResponseSchema>;

/**
 * Un code distinct par condition de refus (L3-04, critère 1) -- extension du catalogue décidée
 * en implémentant L3-04 : la spécification exige un motif distinct pour chaque condition
 * (approbation, moto affectée, assurance, permis, plafond d'encaisse), le contrat n'en portait
 * qu'une. Même précédent que L2-04 (extension additive du contrat, amoa/questions/L2-04.md).
 */
export const SetAvailabilityErrors = [
  'DRIVER_NOT_APPROVED',
  'MOTORCYCLE_NOT_ASSIGNED',
  'INSURANCE_EXPIRED',
  'LICENSE_EXPIRED',
  'CASH_LIMIT_REACHED',
  'DRIVER_HAS_ACTIVE_RIDE',
] as const;

export const setAvailabilityRequestExample: SetAvailabilityRequest = {
  online: true,
};

export const setAvailabilityResponseExample: SetAvailabilityResponse = {
  online: true,
};
