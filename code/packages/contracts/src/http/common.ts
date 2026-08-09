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
