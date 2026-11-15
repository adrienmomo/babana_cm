import { z } from 'zod';
import { IsoDateTimeSchema, RideIdSchema } from './common';

/**
 * Solde prépayé du chauffeur (15 novembre). Rechargé en espèces à l'agence ; chaque course
 * terminée en débite la commission (`commissionRatePercent` du prix). Au-dessous de
 * `minimumBalance` inclus, le passage en ligne est refusé (`INSUFFICIENT_BALANCE`). L'app affiche,
 * elle ne calcule rien (invariant 3).
 */
export const WalletMovementTypeSchema = z.enum(['topup', 'commission', 'adjustment']);

export const WalletMovementSchema = z.object({
  type: WalletMovementTypeSchema,
  /** Positif : recharge ; négatif : commission. En FCFA. */
  amount: z.number().int(),
  at: IsoDateTimeSchema,
  rideId: RideIdSchema.nullable(),
  reference: z.string().nullable(),
});
export type WalletMovement = z.infer<typeof WalletMovementSchema>;

/** GET /drivers/me/wallet */
export const DriverWalletResponseSchema = z.object({
  balance: z.number().int(),
  minimumBalance: z.number().int(),
  commissionRatePercent: z.number().nonnegative(),
  /** Les plus récents d'abord, au plus 20. */
  movements: z.array(WalletMovementSchema).max(20),
});
export type DriverWalletResponse = z.infer<typeof DriverWalletResponseSchema>;
export const DriverWalletErrors = ['UNAUTHORIZED'] as const;

export const driverWalletResponseExample: DriverWalletResponse = {
  balance: 4930,
  minimumBalance: 0,
  commissionRatePercent: 10,
  movements: [
    { type: 'commission', amount: -70, at: '2026-11-15T10:12:00+00:00', rideId: '11111111-2222-4333-8444-555555555555', reference: null },
    { type: 'topup', amount: 5000, at: '2026-11-15T07:30:00+00:00', rideId: null, reference: 'R-0042' },
  ],
};
