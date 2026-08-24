import { z } from 'zod';
import { IsoDateTimeSchema, LatLngSchema } from './common';

/**
 * Bouton d'urgence (L8-04, CDC §II.6). Un seul endpoint, déclenchable par le client ou le
 * chauffeur pendant une course active -- l'acteur se déduit du jeton d'authentification côté
 * serveur (invariant 3), jamais transmis dans le corps de la requête.
 */

export const TriggerIncidentRequestSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  /** Horodatage d'origine du déclenchement, posé côté appareil -- distinct de l'horodatage
   * d'enregistrement serveur quand la requête a été mise en file hors connexion (critère
   * d'acceptation 6) puis rejouée une fois le réseau revenu. */
  triggeredAt: IsoDateTimeSchema,
});
export type TriggerIncidentRequest = z.infer<typeof TriggerIncidentRequestSchema>;

export const TriggerIncidentResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('open'),
  position: LatLngSchema,
  triggeredAt: IsoDateTimeSchema,
});
export type TriggerIncidentResponse = z.infer<typeof TriggerIncidentResponseSchema>;

export const TriggerIncidentErrors = ['RIDE_NOT_FOUND', 'RIDE_NOT_OWNED', 'RIDE_NOT_ACTIVE'] as const;

export const triggerIncidentRequestExample: TriggerIncidentRequest = {
  latitude: 4.0511,
  longitude: 9.7679,
  triggeredAt: '2026-08-24T21:12:03.000Z',
};

export const triggerIncidentResponseExample: TriggerIncidentResponse = {
  id: '9d6e6d1a-9b1b-4b8a-9e3a-2f7b6b1e9a10',
  status: 'open',
  position: { latitude: 4.0511, longitude: 9.7679 },
  triggeredAt: '2026-08-24T21:12:03.000Z',
};
