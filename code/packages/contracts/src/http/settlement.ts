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
 * Une entrée de l'historique des remises du chauffeur (L5-07, GET /drivers/me/cash).
 * `status` reprend le même vocabulaire public que CreateRemittanceResponseSchema
 * (remittance.ts) -- trois valeurs, jamais les quatre états internes de
 * babana.cash.remittance.state (D17 : un format de fil ne se redéclare pas ailleurs).
 * `countedAmount` et `supervisorName` restent `null` tant que la remise n'a pas été
 * validée -- il n'y a encore ni comptage ni superviseur à afficher.
 */
export const RemittanceHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  declaredAt: z.string().datetime().describe('D40 : toujours UTC suffixé'),
  amount: MoneyAmountSchema.describe('montant déclaré par le chauffeur'),
  countedAmount: MoneyAmountSchema.nullable().describe('montant compté par le superviseur -- null tant que non validée'),
  status: z.enum(['pending', 'validated', 'rejected']),
  supervisorName: z.string().nullable(),
});
export type RemittanceHistoryEntry = z.infer<typeof RemittanceHistoryEntrySchema>;

/**
 * GET /drivers/me/cash
 * Solde courant, plafond, marge avant plafond, encaissé du jour, historique des remises (D8,
 * L5-07). `marginRemaining` précalculé côté serveur, même raisonnement que sur
 * SettleRideResponseSchema ci-dessus : « l'écran n'a plus à le chercher/dériver » -- le solde
 * est une donnée financière, jamais recalculée dans l'app (L5-07, critère 3).
 *
 * `remittances` comble un trou du découpage (L5-07 ne listait aucun contrôleur, seulement
 * l'écran) : D35 (01-architecture.md §5) a aboli le JSON-RPC natif pour toute lecture mobile,
 * y compris les « lectures secondaires » comme un historique -- la seule route qui reste est
 * un contrôleur explicite sous /api/v1. Étendre cet endpoint plutôt qu'en ouvrir un second
 * évite un aller-retour de plus sur un réseau intermittent (CLAUDE.md) pour un écran qui
 * affiche les deux à la fois.
 */
export const DriverCashResponseSchema = z.object({
  balance: MoneyAmountSchema,
  limit: MoneyAmountSchema.describe('plafond d\'encaisse, valeur provisoire en base — jamais codée en dur (D21, invariant 5)'),
  marginRemaining: MoneyAmountSchema.describe('max(0, limit - balance) -- ce qui reste avant blocage, précalculé côté serveur'),
  collectedToday: MoneyAmountSchema,
  remittances: z.array(RemittanceHistoryEntrySchema).describe('les plus récentes en tête'),
});
export type DriverCashResponse = z.infer<typeof DriverCashResponseSchema>;

export const DriverCashErrors = ['DRIVER_NOT_APPROVED'] as const;

export const driverCashResponseExample: DriverCashResponse = {
  balance: 8400,
  limit: 15000,
  marginRemaining: 6600,
  collectedToday: 8400,
  remittances: [
    {
      id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
      declaredAt: '2026-08-30T07:15:00Z',
      amount: 12000,
      countedAmount: 12000,
      status: 'validated',
      supervisorName: 'Awa Ngo',
    },
    {
      id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
      declaredAt: '2026-08-31T16:40:00Z',
      amount: 8400,
      countedAmount: null,
      status: 'pending',
      supervisorName: null,
    },
  ],
};
