import { z } from 'zod';
import { LatLngSchema, DriverIdSchema } from './common';

/**
 * Endpoints chauffeur hors caisse (la caisse vit dans settlement.ts, thématiquement liée à
 * l'encaissement). Fichier non listé explicitement dans l'arborescence de la spécification
 * C-01 (implémentation, voir le message de commit).
 */

/**
 * GET /drivers/nearby
 * Les 5 chauffeurs les plus proches (D14). Garde-fous C2b : nombre plafonné à 5, position
 * arrondie — jamais l'objet chauffeur complet.
 */
export const NearbyDriversQuerySchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type NearbyDriversQuery = z.infer<typeof NearbyDriversQuerySchema>;

/**
 * .strict() : mêmes garde-fous que nearby.drivers en C-02 (C2b) — rejeter le surplus, pas
 * seulement valider les champs présents. Aucun nom complet, téléphone ou immatriculation.
 */
export const NearbyDriverSchema = z
  .object({
    driverId: DriverIdSchema,
    firstName: z.string(),
    photoUrl: z.string().url().nullable(),
    rating: z.number().min(0).max(5),
    motorcycleClass: z.enum(['standard', 'premium']),
    /** Position arrondie — précision fixée dans docs/contracts/realtime-events.md (C-02), même règle que nearby.drivers. */
    position: LatLngSchema,
    distanceMeters: z.number().int().nonnegative(),
  })
  .strict();
export type NearbyDriver = z.infer<typeof NearbyDriverSchema>;

export const NearbyDriversResponseSchema = z.object({
  drivers: z.array(NearbyDriverSchema).max(5),
});
export type NearbyDriversResponse = z.infer<typeof NearbyDriversResponseSchema>;

export const NearbyDriversErrors = ['LOCATION_REQUIRED', 'RATE_LIMITED'] as const;

export const nearbyDriversQueryExample: NearbyDriversQuery = {
  latitude: 4.0511,
  longitude: 9.7679,
};

export const nearbyDriversResponseExample: NearbyDriversResponse = {
  drivers: [
    {
      driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      firstName: 'Paul',
      photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
      rating: 4.8,
      motorcycleClass: 'standard',
      position: { latitude: 4.0509, longitude: 9.7683 },
      distanceMeters: 350,
    },
  ],
};

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

export const SetAvailabilityErrors = ['DRIVER_NOT_APPROVED'] as const;

export const setAvailabilityRequestExample: SetAvailabilityRequest = {
  online: true,
};

export const setAvailabilityResponseExample: SetAvailabilityResponse = {
  online: true,
};
