import { z } from 'zod';

/**
 * Rattachement et vérification du numéro de téléphone (01-architecture.md §5) : un seul OTP
 * dans la vie du compte, au moment du rattachement — pas à chaque connexion.
 * Fichier non listé explicitement dans l'arborescence de la spécification C-01 (implémentation,
 * voir le message de commit).
 */

export const PhoneVerifyStartRequestSchema = z.object({
  phoneNumber: z.string().regex(/^\+237[6-9]\d{8}$/, 'Numéro camerounais au format E.164, ex. +237691234567'),
});
export type PhoneVerifyStartRequest = z.infer<typeof PhoneVerifyStartRequestSchema>;

export const PhoneVerifyStartResponseSchema = z.object({
  verificationId: z.string().uuid(),
  expiresIn: z.number().int().positive().describe('secondes avant expiration du code OTP'),
});
export type PhoneVerifyStartResponse = z.infer<typeof PhoneVerifyStartResponseSchema>;

export const PhoneVerifyStartErrors = ['PHONE_ALREADY_VERIFIED', 'RATE_LIMITED'] as const;

export const phoneVerifyStartRequestExample: PhoneVerifyStartRequest = {
  phoneNumber: '+237691234567',
};

export const phoneVerifyStartResponseExample: PhoneVerifyStartResponse = {
  verificationId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  expiresIn: 300,
};

export const PhoneVerifyConfirmRequestSchema = z.object({
  verificationId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, 'code à 6 chiffres'),
});
export type PhoneVerifyConfirmRequest = z.infer<typeof PhoneVerifyConfirmRequestSchema>;

export const PhoneVerifyConfirmResponseSchema = z.object({
  phoneVerified: z.literal(true),
});
export type PhoneVerifyConfirmResponse = z.infer<typeof PhoneVerifyConfirmResponseSchema>;

export const PhoneVerifyConfirmErrors = ['OTP_INVALID', 'OTP_EXPIRED', 'PHONE_ALREADY_VERIFIED'] as const;

export const phoneVerifyConfirmRequestExample: PhoneVerifyConfirmRequest = {
  verificationId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  code: '482913',
};

export const phoneVerifyConfirmResponseExample: PhoneVerifyConfirmResponse = {
  phoneVerified: true,
};
