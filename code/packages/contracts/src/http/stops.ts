import { z } from 'zod';
import { LatLngSchema, MoneyAmountSchema, IsoDateTimeSchema } from './common';
import { FareBreakdownSchema } from './quote';
import { PlaceLabelSchema, RideSummarySchema } from './ride';

/**
 * Arrêts d'une course (L4-14, amoa/specs/L4-course.md ; cadrage
 * amoa/questions/MULTISTOP-2026-11-17.md). Ce ne sont pas des transitions : la course reste
 * `in_progress`. Chaque événement est une écriture, jamais un compteur (invariant 1).
 *
 * **Aucune attente n'est montrée au client pendant la course** : aucune réponse ci-dessous ne
 * porte de durée ni de montant d'attente. L'attente apparaît seulement sur le résumé de fin.
 */

export const StopIdSchema = z.string().uuid();

export const RideStopSchema = z.object({
  id: StopIdSchema,
  sequence: z.number().int().nonnegative(),
  position: LatLngSchema,
  label: z.string().nullable(),
  /** `planned` : coté (devis ou ajout confirmé). `unplanned` : « Arrêt client » du chauffeur. */
  kind: z.enum(['planned', 'unplanned']),
  addedDuringRide: z.boolean(),
});
export type RideStop = z.infer<typeof RideStopSchema>;

/** Réponse commune : la course et ses arrêts, dans l'ordre. */
export const RideWithStopsResponseSchema = RideSummarySchema.extend({
  stops: z.array(RideStopSchema),
});
export type RideWithStopsResponse = z.infer<typeof RideWithStopsResponseSchema>;

/**
 * Heure de l'événement mesurée par le téléphone (D40 : ISO avec fuseau). Le serveur la borne à
 * [événement précédent du même point, réception] et garde l'heure brute pour l'audit ; absente,
 * l'heure de réception fait foi. Un événement mis en file hors connexion garde ainsi l'heure où
 * il s'est produit, pas celle où le réseau est revenu.
 */
const OccurredAtSchema = IsoDateTimeSchema.optional();

/**
 * POST /rides/{id}/stops/quote -- client, course `in_progress`.
 * Cote l'itinéraire prévu complet avec l'arrêt ajouté (à la suite des arrêts prévus), avec la
 * règle tarifaire de la course. N'écrit rien sur la course : le client confirme ensuite.
 */
export const QuoteAddedStopRequestSchema = z.object({
  position: LatLngSchema,
  label: PlaceLabelSchema.optional(),
});
export type QuoteAddedStopRequest = z.infer<typeof QuoteAddedStopRequestSchema>;

export const QuoteAddedStopResponseSchema = z.object({
  quoteId: z.string().uuid(),
  rideId: z.string().uuid(),
  /** Nouveau prix prévu de la course entière -- à confirmer. */
  amount: MoneyAmountSchema,
  /** Prix prévu actuel, pour l'écran de confirmation (« 1 500 → 1 900 FCFA »). */
  previousAmount: MoneyAmountSchema,
  currency: z.literal('XAF'),
  distanceMeters: z.number().int().nonnegative(),
  stopCount: z.number().int().nonnegative(),
  breakdown: FareBreakdownSchema,
  expiresAt: IsoDateTimeSchema,
});
export type QuoteAddedStopResponse = z.infer<typeof QuoteAddedStopResponseSchema>;

export const QuoteAddedStopErrors = [
  'RIDE_NOT_FOUND',
  'RIDE_NOT_OWNED',
  'RIDE_INVALID_TRANSITION',
  'TOO_MANY_STOPS',
  'ROUTE_UNAVAILABLE',
] as const;

/**
 * POST /rides/{id}/stops -- client. Confirme une cotation : l'arrêt est ajouté, le prix prévu
 * devient celui de la cotation, le chauffeur est prévenu (`ride.stop.added`) et ne peut pas
 * refuser. Une cotation expirée, ou devenue fausse parce qu'un autre ajout a été confirmé
 * entre-temps, renvoie `QUOTE_EXPIRED`.
 */
export const ConfirmAddedStopRequestSchema = z.object({ quoteId: z.string().uuid() });
export type ConfirmAddedStopRequest = z.infer<typeof ConfirmAddedStopRequestSchema>;

export const ConfirmAddedStopErrors = [
  'RIDE_NOT_FOUND',
  'RIDE_NOT_OWNED',
  'RIDE_INVALID_TRANSITION',
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'TOO_MANY_STOPS',
] as const;

/** POST /rides/{id}/stops/arrived -- chauffeur. Arrivée à un arrêt prévu (auto ou « Arrivé »). */
export const StopArrivedRequestSchema = z.object({
  stopId: StopIdSchema,
  occurredAt: OccurredAtSchema,
});
export type StopArrivedRequest = z.infer<typeof StopArrivedRequestSchema>;

/**
 * POST /rides/{id}/stops/departed -- chauffeur. Départ (mouvement détecté, ou « Repartir »).
 * `stopId` absent : départ de la prise en charge, course encore `assigned`.
 */
export const StopDepartedRequestSchema = z.object({
  stopId: StopIdSchema.optional(),
  occurredAt: OccurredAtSchema,
});
export type StopDepartedRequest = z.infer<typeof StopDepartedRequestSchema>;

/** POST /rides/{id}/stops/unplanned -- chauffeur. « Arrêt client » : arrêt imprévu, déjà atteint. */
export const StopUnplannedRequestSchema = z.object({
  position: LatLngSchema,
  occurredAt: OccurredAtSchema,
});
export type StopUnplannedRequest = z.infer<typeof StopUnplannedRequestSchema>;

export const DriverStopEventErrors = [
  'RIDE_NOT_FOUND',
  'RIDE_INVALID_TRANSITION',
  'DRIVER_NOT_IN_PROPOSAL',
  'STOP_NOT_FOUND',
] as const;

// --- Exemples ---------------------------------------------------------------------------------

const exampleSummary = {
  id: '3f2b8c1a-9d4e-4b6a-8f1c-2e5d7a9b0c3d',
  state: 'in_progress' as const,
  origin: { latitude: 4.0511, longitude: 9.7679 },
  destination: { latitude: 4.0611, longitude: 9.7861 },
  amount: 1500,
  currency: 'XAF' as const,
  createdAt: '2026-11-17T07:00:00Z',
  assignedDriverId: '5a1c9e2b-7d3f-4e8a-b6c0-1f2d3e4a5b6c',
};

const exampleStop: RideStop = {
  id: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  sequence: 1,
  position: { latitude: 4.0560, longitude: 9.7750 },
  label: 'Pharmacie du rond-point',
  kind: 'planned',
  addedDuringRide: true,
};

export const quoteAddedStopRequestExample: QuoteAddedStopRequest = {
  position: { latitude: 4.0560, longitude: 9.7750 },
  label: 'Pharmacie du rond-point',
};

export const quoteAddedStopResponseExample: QuoteAddedStopResponse = {
  quoteId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  rideId: exampleSummary.id,
  amount: 1900,
  previousAmount: 1500,
  currency: 'XAF',
  distanceMeters: 5600,
  stopCount: 1,
  breakdown: {
    baseFare: 200,
    approachFare: 100,
    distanceFare: 560,
    surgeAmount: 0,
    stopFare: 100,
    discountAmount: 0,
    floorAmount: 0,
    roundingAmount: 15,
    minimumFareApplied: false,
  },
  expiresAt: '2026-11-17T07:20:00Z',
};

export const confirmAddedStopRequestExample: ConfirmAddedStopRequest = {
  quoteId: quoteAddedStopResponseExample.quoteId,
};

export const rideWithStopsResponseExample: RideWithStopsResponse = {
  ...exampleSummary,
  amount: 1900,
  stops: [exampleStop],
};

export const stopArrivedRequestExample: StopArrivedRequest = {
  stopId: exampleStop.id,
  occurredAt: '2026-11-17T07:18:00Z',
};

export const stopDepartedRequestExample: StopDepartedRequest = {
  stopId: exampleStop.id,
  occurredAt: '2026-11-17T07:22:30Z',
};

export const stopUnplannedRequestExample: StopUnplannedRequest = {
  position: { latitude: 4.0580, longitude: 9.7800 },
  occurredAt: '2026-11-17T07:25:00Z',
};
