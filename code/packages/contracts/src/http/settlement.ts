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

export const SettleRideResponseSchema = z.object({
  rideId: RideIdSchema,
  state: z.literal('settled'),
  amountCollected: MoneyAmountSchema,
  driverCashBalance: MoneyAmountSchema.describe('solde du compte courant chauffeur après cet encaissement (D8)'),
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
