import { z } from 'zod';
import { UserIdSchema } from './common';

/**
 * POST /auth/google
 * Échange d'un ID token Google contre un jeton applicatif (D4). Seul endpoint du contrat
 * qui n'exige pas d'en-tête Authorization.
 */
export const GoogleAuthRequestSchema = z.object({
  idToken: z.string().min(1),
  /**
   * Rôle du premier appel : décide, à la création du compte, s'il faut créer un
   * `babana.driver` ou rattacher un `res.partner` client (L1-01). Rien d'autre dans le jeton
   * Google ne porte cette information. Écart relevé et tranché : amoa/questions/L1-01.md.
   */
  role: z.enum(['client', 'driver']),
});
export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;

/**
 * Objet utilisateur porté par une session ET par la réponse de `GET /me` (D35, 22 août) --
 * même schéma, une seule définition. Avant D35, ce schéma n'existait qu'inline dans
 * `AuthSessionSchema.user` ; l'absence d'un endpoit dédié au profil a produit le détournement
 * que D35 corrige (voir plus bas, `MeResponseSchema`).
 */
export const AuthenticatedUserSchema = z.object({
  id: UserIdSchema,
  role: z.enum(['client', 'driver']),
  displayName: z.string(),
  photoUrl: z.string().url().nullable(),
  phoneVerified: z.boolean(),
  /**
   * Statut de validation du dossier, présent seulement quand role vaut 'driver' (L1-01,
   * spécification : "pour un chauffeur, son statut de validation"). Absent du schéma
   * d'origine — champ manquant relevé en implémentant L1-01, voir amoa/questions/L1-01.md.
   * Un chauffeur non approuvé reçoit tout de même un jeton (critère d'acceptation 8) ; c'est
   * ce champ qui porte l'information, pas un rejet de l'authentification.
   */
  driverStatus: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive().describe('secondes avant expiration de accessToken'),
  user: AuthenticatedUserSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const GoogleAuthResponseSchema = AuthSessionSchema;
export type GoogleAuthResponse = z.infer<typeof GoogleAuthResponseSchema>;

// DRIVER_NOT_APPROVED n'est jamais renvoyée par cet endpoint : un chauffeur non approuvé reçoit
// tout de même un jeton, avec un statut `pending` explicite (L1-01, critère d'acceptation 8) —
// ce sont les endpoints métier qui refusent ses actions, pas l'authentification. Retirée du
// catalogue de cet endpoint (contrat corrigé pendant l'implémentation de L1-01).
export const GoogleAuthErrors = ['INVALID_GOOGLE_TOKEN'] as const;

export const googleAuthRequestExample: GoogleAuthRequest = {
  idToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYzEyMyJ9.mock-signed-by-mock-google-identity',
  role: 'client',
};

export const googleAuthResponseExample: GoogleAuthResponse = {
  accessToken: 'app_at_9f1c2e3d4b5a',
  refreshToken: 'app_rt_1a2b3c4d5e6f',
  expiresIn: 3600,
  user: {
    id: '3f6a2b1c-4d5e-4f6a-8b9c-0d1e2f3a4b5c',
    role: 'client',
    displayName: 'Amina N.',
    photoUrl: 'https://lh3.googleusercontent.com/mock/amina.jpg',
    phoneVerified: false,
  },
};

/**
 * POST /auth/refresh
 * Renouvellement du jeton applicatif à partir du jeton de renouvellement.
 */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = AuthSessionSchema;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const RefreshErrors = ['TOKEN_EXPIRED', 'TOKEN_REVOKED', 'UNAUTHORIZED'] as const;

export const refreshRequestExample: RefreshRequest = {
  refreshToken: 'app_rt_1a2b3c4d5e6f',
};

export const refreshResponseExample: RefreshResponse = googleAuthResponseExample;

/**
 * POST /auth/logout
 * Révocation du jeton de renouvellement fourni. L'accessToken en circulation reste valide
 * jusqu'à son expiration naturelle (courte, cf. expiresIn) — pas de liste de révocation
 * temps réel pour un jeton de si courte durée.
 */
export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const LogoutResponseSchema = z.object({
  revoked: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const LogoutErrors = ['UNAUTHORIZED'] as const;

export const logoutRequestExample: LogoutRequest = {
  refreshToken: 'app_rt_1a2b3c4d5e6f',
};

export const logoutResponseExample: LogoutResponse = {
  revoked: true,
};

/**
 * GET /me
 * Profil de l'utilisateur courant (D35, 22 août). N'existait pas avant D35 : le profil figurait
 * dans la liste des « lectures secondaires » réservées au JSON-RPC natif d'Odoo, qui n'accepte
 * pas notre jeton applicatif -- l'app appelait `/auth/refresh` au démarrage faute d'alternative,
 * ce qui multipliait les occasions de perdre une famille de jetons (D36). Même schéma que
 * `AuthSessionSchema.user`, une seule définition (`AuthenticatedUserSchema` ci-dessus).
 */
export const MeResponseSchema = AuthenticatedUserSchema;
export type MeResponse = z.infer<typeof MeResponseSchema>;

// Rien au-delà des erreurs implicites (UNAUTHORIZED, TOKEN_EXPIRED) : une lecture de profil ne
// refuse jamais un chauffeur non approuvé, même raison que /auth/google (critère 8, L1-01).
export const MeErrors = [] as const;

export const meResponseExample: MeResponse = googleAuthResponseExample.user;
