import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * « Ma priorité » (19 novembre, amoa/questions/PRIORITE-2026-11-19.md). Le total et ses trois
 * composantes sont dans `AuthenticatedUser.driverPriority` (`GET /me`) ; ces deux endpoints
 * portent le détail. Tout vient du serveur -- l'app n'applique aucun barème (invariant 3).
 *
 * GET /drivers/me/priority/ride-points -- le journal des points de course : une ligne par
 * proposition expirée (`missed`, delta négatif) et par course terminée (`completed`, delta
 * positif), de la plus récente à la plus ancienne, par pages (même `cursor` que GET /rides).
 * `balanceAfter` est le solde après la ligne : au plafond, un `+1` le laisse inchangé.
 */
export const RidePointsLogEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['missed', 'completed']),
  delta: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  occurredAt: IsoDateTimeSchema,
  /** Référence de la course concernée, `null` si elle n'existe plus. */
  rideReference: z.string().nullable(),
  pickupLabel: z.string().nullable(),
  dropoffLabel: z.string().nullable(),
});
export type RidePointsLogEntry = z.infer<typeof RidePointsLogEntrySchema>;

export const RidePointsLogQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});
export type RidePointsLogQuery = z.infer<typeof RidePointsLogQuerySchema>;

export const RidePointsLogResponseSchema = z.object({
  ridePoints: z.number().int().nonnegative(),
  ridePointsMax: z.number().int().positive(),
  entries: z.array(RidePointsLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type RidePointsLogResponse = z.infer<typeof RidePointsLogResponseSchema>;

export const RidePointsLogErrors = [] as const;

/**
 * GET /drivers/me/priority/stars -- comment les points de note se calculent, sans la liste des
 * avis : leur nombre et leur moyenne réelle, les notes imaginaires de départ, la moyenne lissée
 * qui décide, et les paliers (du plus haut au plus bas). Un seul est `applied` -- le plus haut
 * dépassé, dont les points sont comptés : les paliers ne s'additionnent pas.
 */
export const StarTierSchema = z.object({
  /** Note lissée strictement au-dessus de laquelle le palier est acquis. */
  above: z.number().nonnegative(),
  points: z.number().int().nonnegative(),
  applied: z.boolean(),
});
export type StarTier = z.infer<typeof StarTierSchema>;

export const StarPointsResponseSchema = z.object({
  starPoints: z.number().int().nonnegative(),
  starPointsMax: z.number().int().nonnegative(),
  smoothedAverage: z.number().nonnegative(),
  ratingCount: z.number().int().nonnegative(),
  /** Moyenne des seuls avis réels, `null` sans avis. */
  ratingAverage: z.number().min(1).max(5).nullable(),
  priorCount: z.number().int().nonnegative(),
  priorValue: z.number().nonnegative(),
  tiers: z.array(StarTierSchema),
});
export type StarPointsResponse = z.infer<typeof StarPointsResponseSchema>;

export const StarPointsErrors = [] as const;

export const driverRidePointsLogRequestExample: RidePointsLogQuery = {};

export const driverRidePointsLogResponseExample: RidePointsLogResponse = {
  ridePoints: 99,
  ridePointsMax: 100,
  entries: [
    {
      id: '42',
      kind: 'missed',
      delta: -1,
      balanceAfter: 99,
      occurredAt: '2026-11-19T09:12:00Z',
      rideReference: 'C2026002711',
      pickupLabel: 'Carrefour Tiff',
      dropoffLabel: 'Marché Sandaga',
    },
    {
      id: '41',
      kind: 'completed',
      delta: 1,
      balanceAfter: 100,
      occurredAt: '2026-11-18T17:40:00Z',
      rideReference: 'C2026002698',
      pickupLabel: 'Akwa',
      dropoffLabel: 'Bonapriso',
    },
  ],
  nextCursor: null,
};

export const driverStarPointsResponseExample: StarPointsResponse = {
  starPoints: 10,
  starPointsMax: 10,
  smoothedAverage: 4.93,
  ratingCount: 12,
  ratingAverage: 4.7,
  priorCount: 50,
  priorValue: 5,
  tiers: [
    { above: 4.5, points: 10, applied: true },
    { above: 4, points: 5, applied: false },
  ],
};
