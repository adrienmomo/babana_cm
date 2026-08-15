import { z } from 'zod';

/**
 * Charge utile du jeton d'accès applicatif (D23, C-01 -- amoa/questions/REPONSES-2026-08-15.md
 * §1). Odoo l'émet en Python (controllers/auth.py:_issue_access_token), le service temps réel
 * la vérifie en TypeScript sans jamais appeler Odoo (services/realtime/src/ws/token.ts) : c'est
 * un format de fil comme un autre, il ne se déclare qu'une fois (D17), ici.
 *
 * `sub`, pas `uid` : le claim enregistré RFC 7519 pour le sujet, compris sans configuration par
 * toute bibliothèque JWT tierce -- porte `res.users.babana_public_id`.
 *
 * `driverId` porte `babana.driver.public_id`, **distinct de `sub`**. Obligatoire si et
 * seulement si `role` vaut 'driver' : le service temps réel en a besoin pour indexer une
 * connexion sans appeler Odoo, ce que sa spécification lui interdit (L3-01).
 *
 * Le jeton de renouvellement n'entre pas dans ce contrat : ce n'est pas un JWT, seul son haché
 * est stocké côté Odoo (L1-02), rien de ce qui le concerne n'est vérifiable ailleurs.
 */
export const AccessTokenClaimsSchema = z
  .object({
    sub: z.string().uuid(),
    role: z.enum(['client', 'driver']),
    driverId: z.string().uuid().optional(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    jti: z.string().uuid(),
  })
  .refine((claims) => (claims.role === 'driver') === (claims.driverId !== undefined), {
    message: "driverId doit être présent si et seulement si role vaut 'driver'",
    path: ['driverId'],
  });

export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;
