import { z } from 'zod';
import { LatLngSchema, DriverIdSchema } from './common';

/**
 * Endpoints chauffeur hors caisse (la caisse vit dans settlement.ts, thématiquement liée à
 * l'encaissement). Fichier non listé explicitement dans l'arborescence de la spécification
 * C-01 (implémentation, voir le message de commit).
 */

/**
 * Chauffeur proche, tel qu'exposé au client (D14). Garde-fous C2b : position arrondie, jamais
 * l'objet chauffeur complet. Servi exclusivement par `nearby.drivers` (C-02, flux WebSocket,
 * `packages/contracts/src/realtime/server-to-client.ts::NearbyDriversPayloadSchema`) --
 * `GET /drivers/nearby` a existé au premier jet de C-01 puis a été retiré du contrat (jamais
 * implémenté, remplacé par le flux avant même d'être câblé ; voir `amoa/questions/C-01R.md` §1)
 * sans que cette forme partagée ne change : seul l'endpoint HTTP a disparu.
 *
 * .strict() : rejeter le surplus, pas seulement valider les champs présents. Aucun nom complet,
 * téléphone ou immatriculation.
 *
 * firstName/photoUrl/rating/motorcycleClass nullables (D30) : un défaut de cache du profil
 * chauffeur (L3-16) ne doit jamais retirer un chauffeur de la flotte -- seule une position
 * manquante l'écarte (sans position, pas de distance, une liste "des plus proches" n'a plus de
 * sens). `null` avoue l'absence de la donnée ; l'app affiche un avatar générique plutôt que
 * d'inventer un prénom ou une note.
 */
export const NearbyDriverSchema = z
  .object({
    driverId: DriverIdSchema,
    firstName: z.string().nullable(),
    photoUrl: z.string().url().nullable(),
    rating: z.number().min(0).max(5).nullable(),
    motorcycleClass: z.enum(['standard', 'premium']).nullable(),
    /** Position arrondie — précision fixée dans docs/contracts/realtime-events.md (C-02), même règle que nearby.drivers. */
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
