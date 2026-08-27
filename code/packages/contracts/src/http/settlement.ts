import { z } from 'zod';
import { MoneyAmountSchema, RideIdSchema } from './common';

/**
 * POST /rides/{id}/settle
 * Transition completed -> settled. Encaissement espèces uniquement (D9, MVP).
 */
export const SettleRideRequestSchema = z.object({
  amountCollected: MoneyAmountSchema,
});
export type SettleRideRequest = z.infer<typeof SettleRideRequestSchema>;

/**
 * La réponse d'encaissement dit **ce qui s'est passé** (J24, amoa/questions/L6-14.md) : l'écran
 * n'infère plus rien. Franchir le plafond n'est pas une erreur -- la transition réussit -- mais
 * le chauffeur passe hors ligne dans la même transaction (L5-02). Sans `cashLimitReached`,
 * l'écran devait le déduire en comparant le solde à un plafond qu'il allait d'abord chercher par
 * un second `GET /drivers/me/cash` ; `cashLimit` supprime aussi ce second aller-retour.
 */
export const SettleRideResponseSchema = z.object({
  rideId: RideIdSchema,
  state: z.literal('settled'),
  amountCollected: MoneyAmountSchema,
  driverCashBalance: MoneyAmountSchema.describe('solde du compte courant chauffeur après cet encaissement (D8)'),
  cashLimit: MoneyAmountSchema.describe("plafond d'encaisse (D8, D28) -- l'écran n'a plus à le chercher par un second appel"),
  cashLimitReached: z
    .boolean()
    .describe(
      'true si cet encaissement a franchi le plafond : le chauffeur est passé hors ligne dans la ' +
        'même transaction (L5-02). false s\'il était déjà hors ligne ou reste sous le plafond.'
    ),
  marginRemaining: MoneyAmountSchema.describe(
    'marge avant plafond après cet encaissement : max(0, cashLimit - driverCashBalance)'
  ),
});
export type SettleRideResponse = z.infer<typeof SettleRideResponseSchema>;

export const SettleRideErrors = [
  'RIDE_NOT_FOUND',
  'RIDE_INVALID_TRANSITION',
  'DRIVER_NOT_IN_PROPOSAL',
  'SETTLEMENT_AMOUNT_MISMATCH',
  'CASH_LIMIT_REACHED',
] as const;

export const settleRideRequestExample: SettleRideRequest = {
  amountCollected: 1200,
};

export const settleRideResponseExample: SettleRideResponse = {
  rideId: '11111111-2222-4333-8444-555555555555',
  state: 'settled',
  amountCollected: 1200,
  driverCashBalance: 8400,
  cashLimit: 15000,
  cashLimitReached: false,
  marginRemaining: 6600,
};

/**
 * GET /drivers/me/cash
 * Solde courant, plafond, encaissé du jour (D8).
 */
export const DriverCashResponseSchema = z.object({
  balance: MoneyAmountSchema,
  limit: MoneyAmountSchema.describe('plafond d\'encaisse, valeur provisoire en base — jamais codée en dur (D21, invariant 5)'),
  collectedToday: MoneyAmountSchema,
});
export type DriverCashResponse = z.infer<typeof DriverCashResponseSchema>;

export const DriverCashErrors = ['DRIVER_NOT_APPROVED'] as const;

export const driverCashResponseExample: DriverCashResponse = {
  balance: 8400,
  limit: 15000,
  collectedToday: 8400,
};
