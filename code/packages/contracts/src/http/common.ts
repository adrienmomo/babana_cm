import { z } from 'zod';

/**
 * Primitives partagées entre les fichiers d'endpoints. Non listé dans l'arborescence de la
 * spécification C-01, ajouté pour éviter de dupliquer les mêmes schémas de géolocalisation et
 * de montant dans quote.ts, ride.ts et driver.ts — choix d'implémentation non spécifié
 * (structure de fichiers), voir le message de commit.
 */

export const LatLngSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

/**
 * Montant en FCFA (XAF). XAF n'a pas de sous-unité : toujours un entier, jamais de décimales.
 * Valeurs provisoires marquées comme telles où elles apparaissent (D21) — jamais codées en dur
 * dans le code de production, seulement dans les exemples de ce contrat.
 */
export const MoneyAmountSchema = z.number().int().nonnegative();
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const RideIdSchema = z.string().uuid();
export const DriverIdSchema = z.string().uuid();
export const UserIdSchema = z.string().uuid();

/**
 * Précision des positions diffusées à un client pour la sélection de chauffeur (D14, C2b) :
 * assez fine pour un affichage crédible, assez grossière pour empêcher la cartographie de la
 * flotte. Utilisé par nearby.drivers (C-02, realtime -- seul chemin de découverte des chauffeurs
 * proches, `GET /drivers/nearby` retiré du contrat, jamais implémenté, voir
 * `amoa/questions/C-01R.md` §1). 4 décimales ≈ 11 m à l'équateur : suffisant pour situer un
 * point sur une carte, insuffisant pour re-suivre précisément un véhicule.
 */
export const NEARBY_POSITION_PRECISION_DECIMALS = 4;

export function roundToNearbyPrecision(value: number): number {
  const factor = 10 ** NEARBY_POSITION_PRECISION_DECIMALS;
  return Math.round(value * factor) / factor;
}
