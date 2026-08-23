import { z } from 'zod';
import { LatLngSchema, MoneyAmountSchema, RideIdSchema, DriverIdSchema, IsoDateTimeSchema } from './common';

/**
 * Cycle de vie de la course. Chaque endpoint correspond à une ou plusieurs transitions de
 * docs/contracts/ride-state-machine.md (C-03) — les préconditions et effets décrits là-bas
 * s'appliquent ici sans être redupliqués.
 */

export const RideStateSchema = z.enum([
  'requested',
  'proposed',
  'assigned',
  'in_progress',
  'completed',
  'settled',
  'rejected',
  'cancelled',
]);
export type RideState = z.infer<typeof RideStateSchema>;

export const RideSummarySchema = z.object({
  id: RideIdSchema,
  state: RideStateSchema,
  origin: LatLngSchema,
  destination: LatLngSchema,
  amount: MoneyAmountSchema,
  currency: z.literal('XAF'),
  createdAt: IsoDateTimeSchema,
  assignedDriverId: DriverIdSchema.nullable(),
});
export type RideSummary = z.infer<typeof RideSummarySchema>;

/**
 * POST /rides
 * Transition draft -> requested : création de la demande à partir d'une estimation.
 */
export const CreateRideRequestSchema = z.object({
  quoteId: z.string().uuid(),
});
export type CreateRideRequest = z.infer<typeof CreateRideRequestSchema>;

export const CreateRideResponseSchema = RideSummarySchema;
export type CreateRideResponse = z.infer<typeof CreateRideResponseSchema>;

export const CreateRideErrors = ['QUOTE_EXPIRED', 'QUOTE_NOT_FOUND'] as const;

export const createRideRequestExample: CreateRideRequest = {
  quoteId: '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c',
};

export const createRideResponseExample: CreateRideResponse = {
  id: '11111111-2222-4333-8444-555555555555',
  state: 'requested',
  origin: { latitude: 4.0511, longitude: 9.7679 },
  destination: { latitude: 4.0611, longitude: 9.7861 },
  amount: 1200,
  currency: 'XAF',
  createdAt: '2026-08-10T07:00:00+01:00',
  assignedDriverId: null,
};

/**
 * POST /rides/{id}/select-driver
 * Transition requested -> proposed, ou rejected -> proposed (D11, même course).
 */
export const SelectDriverRequestSchema = z.object({
  driverId: DriverIdSchema,
});
export type SelectDriverRequest = z.infer<typeof SelectDriverRequestSchema>;

export const SelectDriverResponseSchema = RideSummarySchema.extend({
  proposalExpiresAt: IsoDateTimeSchema,
});
export type SelectDriverResponse = z.infer<typeof SelectDriverResponseSchema>;

export const SelectDriverErrors = [
  'RIDE_NOT_FOUND',
  'RIDE_NOT_OWNED',
  'RIDE_INVALID_TRANSITION',
  'DRIVER_ALREADY_TAKEN',
  // Ajouté en implémentant L4-03 : action_propose refuse un chauffeur qui n'est plus
  // 'approved' (suspendu entre l'affichage de nearby.drivers et la sélection, par exemple).
  // Absent de la première rédaction de ce contrat -- voir le message de commit de L4-03.
  'DRIVER_NOT_APPROVED',
] as const;

export const selectDriverRequestExample: SelectDriverRequest = {
  driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
};

export const selectDriverResponseExample: SelectDriverResponse = {
  ...createRideResponseExample,
  state: 'proposed',
  assignedDriverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  proposalExpiresAt: '2026-08-10T07:00:30+01:00',
};

/**
 * Acceptation et refus n'ont plus de route HTTP publique (D31,
 * amoa/questions/REPONSES-2026-08-18.md §3) : un seul chemin d'écriture, `proposal.accept` /
 * `proposal.reject` en temps réel (C-02), résolus atomiquement côté service temps réel puis
 * écrits dans Odoo par le canal interne (`/api/internal/rides/{id}/driver-accepted` /
 * `driver-rejected`, controllers/internal.py) -- jamais un second chemin qui ignorerait la
 * réservation atomique (même défaut de fond que D26). `RideSummary.state` passe directement de
 * `proposed` à `assigned` ou `rejected` du point de vue du client, porté par `ride.assigned` /
 * `ride.rejected` (C-02), jamais par une réponse HTTP à cet endpoint.
 */
const rideAcceptedExample: RideSummary = {
  ...selectDriverResponseExample,
  state: 'assigned',
};

/**
 * POST /rides/{id}/start
 * Transition assigned -> in_progress. Appelé par le chauffeur.
 */
export const StartRideRequestSchema = z.object({});
export type StartRideRequest = z.infer<typeof StartRideRequestSchema>;

export const StartRideResponseSchema = RideSummarySchema;
export type StartRideResponse = z.infer<typeof StartRideResponseSchema>;

export const StartRideErrors = ['RIDE_NOT_FOUND', 'RIDE_INVALID_TRANSITION', 'DRIVER_NOT_IN_PROPOSAL'] as const;

export const startRideRequestExample: StartRideRequest = {};

export const startRideResponseExample: StartRideResponse = {
  ...rideAcceptedExample,
  state: 'in_progress',
};

/**
 * POST /rides/{id}/complete
 * Transition in_progress -> completed. Consolidation distance, durée, montant.
 */
export const CompleteRideRequestSchema = z.object({
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  polyline: z.string().min(1).describe('polyline encodée du trajet effectivement parcouru'),
});
export type CompleteRideRequest = z.infer<typeof CompleteRideRequestSchema>;

export const CompleteRideResponseSchema = RideSummarySchema.extend({
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
});
export type CompleteRideResponse = z.infer<typeof CompleteRideResponseSchema>;

export const CompleteRideErrors = ['RIDE_NOT_FOUND', 'RIDE_INVALID_TRANSITION', 'DRIVER_NOT_IN_PROPOSAL'] as const;

export const completeRideRequestExample: CompleteRideRequest = {
  distanceMeters: 4350,
  durationSeconds: 820,
  polyline: 'a~l~Fjk~uOwHJy@P',
};

export const completeRideResponseExample: CompleteRideResponse = {
  ...startRideResponseExample,
  state: 'completed',
  distanceMeters: 4350,
  durationSeconds: 820,
};

/**
 * POST /rides/{id}/cancel
 * Transition requested|proposed|assigned|rejected -> cancelled.
 */
export const CancelRideRequestSchema = z.object({
  reason: z.string().min(1).max(280).optional(),
});
export type CancelRideRequest = z.infer<typeof CancelRideRequestSchema>;

export const CancelRideResponseSchema = RideSummarySchema;
export type CancelRideResponse = z.infer<typeof CancelRideResponseSchema>;

export const CancelRideErrors = ['RIDE_NOT_FOUND', 'RIDE_NOT_OWNED', 'RIDE_INVALID_TRANSITION'] as const;

export const cancelRideRequestExample: CancelRideRequest = {
  reason: 'Changement de plan',
};

export const cancelRideResponseExample: CancelRideResponse = {
  ...createRideResponseExample,
  state: 'cancelled',
};

/**
 * POST /rides/{id}/rate
 * N'est pas une transition d'état (la course reste settled) : une note ajoutée après coup.
 */
export const RateRideRequestSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});
export type RateRideRequest = z.infer<typeof RateRideRequestSchema>;

export const RateRideResponseSchema = z.object({
  rideId: RideIdSchema,
  rating: z.number().int().min(1).max(5),
});
export type RateRideResponse = z.infer<typeof RateRideResponseSchema>;

export const RateRideErrors = ['RIDE_NOT_FOUND', 'RIDE_NOT_OWNED', 'RATING_NOT_ALLOWED', 'RATING_ALREADY_SUBMITTED'] as const;

export const rateRideRequestExample: RateRideRequest = {
  rating: 5,
  comment: 'Trajet rapide et sûr',
};

export const rateRideResponseExample: RateRideResponse = {
  rideId: '11111111-2222-4333-8444-555555555555',
  rating: 5,
};
