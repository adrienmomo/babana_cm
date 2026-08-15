import { z } from 'zod';
import { LatLngSchema, MoneyAmountSchema, IsoDateTimeSchema } from './common';

/**
 * POST /quote
 * Estimation d'une course. Le montant, la distance et l'ETA sont calculés côté serveur
 * (invariant 3 : aucune règle tarifaire dans les applications). L'application n'affiche que ce
 * que cette réponse contient.
 */
export const VehicleClassSchema = z.enum(['standard', 'premium']);
export type VehicleClass = z.infer<typeof VehicleClassSchema>;

export const QuoteRequestSchema = z.object({
  origin: LatLngSchema,
  destination: LatLngSchema,
  /**
   * Gamme souhaitée (amoa/specs/L2-tarification.md, L2-04 : « départ, arrivée, gamme
   * souhaitée, code promo éventuel »), absente de la première rédaction de ce schéma. Optionnel
   * plutôt qu'obligatoire — 'standard' par défaut côté contrôleur — pour ne pas casser un
   * appelant déjà écrit contre l'ancien schéma (aucun n'existe encore ce soir, mais le principe
   * D17 vaut par précaution). Ajouté en implémentant L2-04, voir amoa/questions/L2-04.md.
   */
  vehicleClass: VehicleClassSchema.optional(),
  promoCode: z.string().min(1).optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

/**
 * Détail décomposé (L2-03 FareBreakdown, critère d'acceptation 4 de L2-04 : « la réponse
 * contient le détail décomposé complet »). Absent de la première rédaction du contrat — ajouté
 * en implémentant L2-04, voir amoa/questions/L2-04.md.
 */
export const FareBreakdownSchema = z.object({
  baseFare: MoneyAmountSchema,
  distanceFare: MoneyAmountSchema,
  surgeAmount: z.number().int(),
  discountAmount: MoneyAmountSchema,
  floorAmount: MoneyAmountSchema,
  roundingAmount: z.number().int(),
  minimumFareApplied: z.boolean(),
});
export type FareBreakdown = z.infer<typeof FareBreakdownSchema>;

export const QuoteResponseSchema = z.object({
  quoteId: z.string().uuid(),
  amount: MoneyAmountSchema,
  currency: z.literal('XAF'),
  breakdown: FareBreakdownSchema,
  distanceMeters: z.number().int().nonnegative(),
  /** Distance et durée voiture (É8) : ni Google ni Mapbox ne calculent d'itinéraire deux-roues au Cameroun. */
  etaSeconds: z.number().int().nonnegative(),
  /**
   * Un code promo fourni mais invalide, expiré ou épuisé n'échoue pas la cotation (critère 5) :
   * l'estimation revient sans remise, avec cet indicateur explicite plutôt qu'une erreur.
   */
  promoApplied: z.boolean(),
  expiresAt: IsoDateTimeSchema,
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const QuoteErrors = [
  'PROMO_CODE_INVALID',
  // Ajouté en implémentant L2-05 : l'indisponibilité de l'API de routage doit produire une
  // erreur explicite, jamais une estimation dégradée silencieuse (amoa/questions/L2-04.md).
  'ROUTE_UNAVAILABLE',
] as const;

export const quoteRequestExample: QuoteRequest = {
  origin: { latitude: 4.0511, longitude: 9.7679 },
  destination: { latitude: 4.0611, longitude: 9.7861 },
  vehicleClass: 'standard',
};

export const quoteResponseExample: QuoteResponse = {
  quoteId: '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c',
  amount: 1200,
  currency: 'XAF',
  breakdown: {
    baseFare: 200,
    distanceFare: 1000,
    surgeAmount: 0,
    discountAmount: 0,
    floorAmount: 0,
    roundingAmount: 0,
    minimumFareApplied: false,
  },
  distanceMeters: 4200,
  etaSeconds: 780,
  promoApplied: false,
  expiresAt: '2026-08-10T07:30:00+01:00',
};
