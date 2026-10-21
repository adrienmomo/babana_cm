import { z } from 'zod';
import { AuthSessionSchema } from './auth';

/**
 * Connexion par numéro de téléphone et code SMS (OTP) -- remplace Google Sign-In comme porte
 * d'entrée des applications. Le numéro vérifié EST l'identité du compte : il n'y a ni mot de passe
 * ni second facteur, chaque connexion passe par un code. Deux routes publiques, sans en-tête
 * Authorization :
 *
 *   POST /auth/otp/request  -> envoie un code par SMS
 *   POST /auth/otp/verify   -> échange le code contre une session (compte créé au premier passage)
 *
 * Toute la règle (format, limites, expiration, essais) est côté serveur (invariant 3) ; le motif
 * du numéro ci-dessous est le seul contrôle partagé, pour qu'une saisie impossible soit refusée
 * avant d'envoyer quoi que ce soit.
 */

export const PHONE_NUMBER_PATTERN = /^\+237[6-9]\d{8}$/;
export const OTP_CODE_LENGTH = 6;

export const OtpRequestRequestSchema = z.object({
  phoneNumber: z.string().regex(PHONE_NUMBER_PATTERN, 'Numéro camerounais au format E.164, ex. +237691234567'),
  /** Décide, à la création du compte seulement, s'il devient client ou candidat chauffeur. Un
   * compte existant garde son rôle d'origine (L1-03R). */
  role: z.enum(['client', 'driver']),
});
export type OtpRequestRequest = z.infer<typeof OtpRequestRequestSchema>;

export const OtpRequestResponseSchema = z.object({
  verificationId: z.string().uuid(),
  expiresIn: z.number().int().positive().describe('secondes avant expiration du code OTP'),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

// SMS_UNAVAILABLE : la passerelle n'a pas pu envoyer le code (aucun code n'est utilisable).
export const OtpRequestErrors = ['RATE_LIMITED', 'SMS_UNAVAILABLE'] as const;

export const otpRequestRequestExample: OtpRequestRequest = {
  phoneNumber: '+237691234567',
  role: 'client',
};

export const otpRequestResponseExample: OtpRequestResponse = {
  verificationId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  expiresIn: 300,
};

export const OtpVerifyRequestSchema = z.object({
  verificationId: z.string().uuid(),
  code: z.string().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`), `code à ${OTP_CODE_LENGTH} chiffres`),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;

export const OtpVerifyResponseSchema = AuthSessionSchema;
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponseSchema>;

// OTP_INVALID : mauvais code, on peut réessayer. OTP_EXPIRED : code expiré, annulé (trop d'essais
// ou remplacé par une nouvelle demande) ou inconnu -- l'app doit en redemander un.
export const OtpVerifyErrors = ['OTP_INVALID', 'OTP_EXPIRED', 'RATE_LIMITED'] as const;

export const otpVerifyRequestExample: OtpVerifyRequest = {
  verificationId: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  code: '482913',
};

export const otpVerifyResponseExample: OtpVerifyResponse = {
  accessToken: 'app_at_9f1c2e3d4b5a',
  refreshToken: 'app_rt_1a2b3c4d5e6f',
  expiresIn: 3600,
  user: {
    id: '3f6a2b1c-4d5e-4f6a-8b9c-0d1e2f3a4b5c',
    role: 'client',
    displayName: '+237691234567',
    photoUrl: null,
    phoneVerified: true,
  },
};
