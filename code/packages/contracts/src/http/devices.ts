import { z } from 'zod';

/**
 * Jetons d'appareil pour la notification push (L7-01, Firebase Cloud Messaging). L'application
 * enregistre son jeton FCM à la connexion et à **chaque rotation** signalée par Firebase ; le
 * serveur en garde plusieurs par utilisateur (un compte, plusieurs appareils) et le même jeton
 * peut appartenir à plusieurs comptes (un appareil partagé, ou réinstallé). L'acteur se déduit
 * du jeton d'authentification (invariant 3), jamais transmis dans le corps.
 *
 * Le **nettoyage** d'un jeton périmé n'est pas piloté par l'app : Firebase signale les jetons
 * invalides dans sa réponse d'envoi, et c'est ce retour qui les désactive côté serveur
 * (`services/push.py`). `deactivate` ci-dessous ne sert qu'au cas explicite « cet appareil se
 * déconnecte » -- jamais un balayage qui devine.
 */

export const DevicePlatformSchema = z.enum(['android', 'ios', 'web']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/**
 * POST /devices
 * Enregistre (ou réactive, si déjà connu) le jeton d'appareil du compte courant.
 */
export const RegisterDeviceTokenRequestSchema = z.object({
  token: z.string().min(1),
  platform: DevicePlatformSchema,
});
export type RegisterDeviceTokenRequest = z.infer<typeof RegisterDeviceTokenRequestSchema>;

export const RegisterDeviceTokenResponseSchema = z.object({
  registered: z.literal(true),
});
export type RegisterDeviceTokenResponse = z.infer<typeof RegisterDeviceTokenResponseSchema>;

// Rien au-delà des erreurs implicites (VALIDATION_ERROR, UNAUTHORIZED, ...) : un enregistrement
// de jeton ne porte aucune règle métier qui puisse échouer autrement.
export const RegisterDeviceTokenErrors = [] as const;

export const registerDeviceTokenRequestExample: RegisterDeviceTokenRequest = {
  token: 'fcm-eXampleRegistrationToken-0001',
  platform: 'android',
};

export const registerDeviceTokenResponseExample: RegisterDeviceTokenResponse = {
  registered: true,
};

/**
 * POST /devices/deactivate
 * Désactive le jeton fourni pour le compte courant -- déconnexion volontaire de cet appareil.
 * Idempotent : désactiver un jeton inconnu ou déjà désactivé répond `deactivated: true`.
 */
export const DeactivateDeviceTokenRequestSchema = z.object({
  token: z.string().min(1),
});
export type DeactivateDeviceTokenRequest = z.infer<typeof DeactivateDeviceTokenRequestSchema>;

export const DeactivateDeviceTokenResponseSchema = z.object({
  deactivated: z.literal(true),
});
export type DeactivateDeviceTokenResponse = z.infer<typeof DeactivateDeviceTokenResponseSchema>;

export const DeactivateDeviceTokenErrors = [] as const;

export const deactivateDeviceTokenRequestExample: DeactivateDeviceTokenRequest = {
  token: 'fcm-eXampleRegistrationToken-0001',
};

export const deactivateDeviceTokenResponseExample: DeactivateDeviceTokenResponse = {
  deactivated: true,
};
