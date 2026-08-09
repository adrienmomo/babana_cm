import { z } from 'zod';
import { LatLngSchema, MoneyAmountSchema, IsoDateTimeSchema } from './common';

/**
 * POST /quote
 * Estimation d'une course. Le montant, la distance et l'ETA sont calculés côté serveur
 * (invariant 3 : aucune règle tarifaire dans les applications). L'application n'affiche que ce
 * que cette réponse contient.
 */
export const QuoteRequestSchema = z.object({
  origin: LatLngSchema,
  destination: LatLngSchema,
  promoCode: z.string().min(1).optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z.object({
  quoteId: z.string().uuid(),
  amount: MoneyAmountSchema,
  currency: z.literal('XAF'),
  distanceMeters: z.number().int().nonnegative(),
  /** Distance et durée voiture (É8) : ni Google ni Mapbox ne calculent d'itinéraire deux-roues au Cameroun. */
  etaSeconds: z.number().int().nonnegative(),
  expiresAt: IsoDateTimeSchema,
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const QuoteErrors = ['PROMO_CODE_INVALID'] as const;

export const quoteRequestExample: QuoteRequest = {
  origin: { latitude: 4.0511, longitude: 9.7679 },
  destination: { latitude: 4.0611, longitude: 9.7861 },
};

export const quoteResponseExample: QuoteResponse = {
  quoteId: '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c',
  amount: 1200,
  currency: 'XAF',
  distanceMeters: 4200,
  etaSeconds: 780,
  expiresAt: '2026-08-10T07:30:00+01:00',
};
