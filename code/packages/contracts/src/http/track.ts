import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * POST /rides/{id}/track -- chauffeur (L4-16). La copie du trajet gardée par le téléphone,
 * téléversée UNE fois après la fin d'une course démarrée (terminée, encaissée, ou annulée en
 * cours de route), par la file hors connexion. Retenue seulement si le service temps réel n'a
 * rien laissé ; filtrée côté serveur (fenêtre de la course, vitesse plausible). Sert la sécurité,
 * jamais le prix : le montant est déjà écrit à la fin de course.
 */
export const TrackPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  capturedAt: IsoDateTimeSchema,
  accuracyMeters: z.number().nonnegative().nullable(),
});
export type TrackPoint = z.infer<typeof TrackPointSchema>;

export const UploadRideTrackRequestSchema = z.object({
  points: z.array(TrackPointSchema),
});
export type UploadRideTrackRequest = z.infer<typeof UploadRideTrackRequestSchema>;

export const UploadRideTrackResponseSchema = z.object({
  rideId: z.string().uuid(),
  /** Vrai si un trajet est enregistré pour cette course -- celui-ci ou un précédent. */
  recorded: z.boolean(),
  /** Origine du trajet retenu : `realtime` gagne toujours sur `phone`. */
  source: z.enum(['realtime', 'phone']).nullable(),
});
export type UploadRideTrackResponse = z.infer<typeof UploadRideTrackResponseSchema>;

export const UploadRideTrackErrors = ['RIDE_NOT_FOUND', 'RIDE_INVALID_TRANSITION', 'DRIVER_NOT_IN_PROPOSAL'] as const;

export const uploadRideTrackRequestExample: UploadRideTrackRequest = {
  points: [
    { latitude: 4.0483, longitude: 9.6934, capturedAt: '2026-11-17T07:10:00Z', accuracyMeters: 6 },
    { latitude: 4.0451, longitude: 9.6961, capturedAt: '2026-11-17T07:11:05Z', accuracyMeters: 8 },
  ],
};

export const uploadRideTrackResponseExample: UploadRideTrackResponse = {
  rideId: '3f2b8c1a-9d4e-4b6a-8f1c-2e5d7a9b0c3d',
  recorded: true,
  source: 'phone',
};
