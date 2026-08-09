import { z } from 'zod';
import { MoneyAmountSchema } from './common';

/**
 * POST /remittances
 * Déclaration d'une remise de caisse par le chauffeur (D8). La validation par un superviseur
 * est un flux back-office Odoo natif, hors de ce contrat mobile.
 */
export const CreateRemittanceRequestSchema = z.object({
  amount: MoneyAmountSchema,
});
export type CreateRemittanceRequest = z.infer<typeof CreateRemittanceRequestSchema>;

export const CreateRemittanceResponseSchema = z.object({
  id: z.string().uuid(),
  amount: MoneyAmountSchema,
  status: z.enum(['pending', 'validated', 'rejected']),
  driverCashBalance: MoneyAmountSchema,
});
export type CreateRemittanceResponse = z.infer<typeof CreateRemittanceResponseSchema>;

export const CreateRemittanceErrors = ['DRIVER_NOT_APPROVED'] as const;

export const createRemittanceRequestExample: CreateRemittanceRequest = {
  amount: 8400,
};

export const createRemittanceResponseExample: CreateRemittanceResponse = {
  id: '2b3c4d5e-6f7a-4b5c-8d9e-0f1a2b3c4d5e',
  amount: 8400,
  status: 'pending',
  driverCashBalance: 0,
};
