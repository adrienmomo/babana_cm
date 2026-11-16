import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * Selfie de contrôle du chauffeur (15 novembre). Le chauffeur se prend en photo, caméra avant, au
 * moins toutes les `intervalHours` heures (réglage serveur, 24 par défaut) ; un gestionnaire le
 * compare à sa photo de profil validée. Un selfie en attente compte : le chauffeur travaille
 * pendant la revue. Le dernier refusé en exige un nouveau ; sans selfie à jour, le passage en
 * ligne est refusé (`SELFIE_REQUIRED`).
 */
export const SelfieStateSchema = z.enum(['pending', 'approved', 'rejected']);
export type SelfieState = z.infer<typeof SelfieStateSchema>;

export const DriverSelfieStatusSchema = z.object({
  /** Un selfie est à prendre avant le prochain passage en ligne. */
  due: z.boolean(),
  lastState: SelfieStateSchema.nullable(),
  rejectionReason: z.string().nullable(),
  /** Échéance du selfie actuel ; `null` si aucun selfie n'a jamais été pris. */
  dueAt: IsoDateTimeSchema.nullable(),
  intervalHours: z.number().int().positive(),
});
export type DriverSelfieStatus = z.infer<typeof DriverSelfieStatusSchema>;

/** GET /drivers/me/selfie */
export const GetDriverSelfieResponseSchema = DriverSelfieStatusSchema;
export type GetDriverSelfieResponse = z.infer<typeof GetDriverSelfieResponseSchema>;
export const GetDriverSelfieErrors = ['UNAUTHORIZED'] as const;

/** POST /drivers/me/selfie -- multipart : `file` (image) et `contentType`. Répond le nouvel état. */
export const UploadDriverSelfieResponseSchema = DriverSelfieStatusSchema;
export type UploadDriverSelfieResponse = z.infer<typeof UploadDriverSelfieResponseSchema>;
export const UploadDriverSelfieErrors = ['VALIDATION_ERROR', 'DOCUMENT_TYPE_MISMATCH', 'UNAUTHORIZED'] as const;

export const driverSelfieStatusExample: DriverSelfieStatus = {
  due: false,
  lastState: 'pending',
  rejectionReason: null,
  dueAt: '2026-11-16T08:00:00+00:00',
  intervalHours: 24,
};
