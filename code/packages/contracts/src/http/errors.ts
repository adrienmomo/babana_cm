import { z } from 'zod';

/**
 * Catalogue nommé des erreurs métier de l'API mobile <-> Odoo (C-01).
 * Indépendant du HTTP : le code est la clé stable, le statut HTTP n'est qu'une projection.
 * Aucun endpoint ne peut renvoyer un code absent de ce catalogue (critère d'acceptation 4).
 */
export const ErrorCode = z.enum([
  // Générique
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',

  // Authentification
  'INVALID_GOOGLE_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'DRIVER_NOT_APPROVED',

  // Bascule en ligne / hors ligne (L3-04) -- chaque condition de refus a son propre code
  // (spécification, critère 1) : DRIVER_NOT_APPROVED (ci-dessus) et CASH_LIMIT_REACHED
  // (plus bas, partagé avec la caisse) complètent cette liste.
  'MOTORCYCLE_NOT_ASSIGNED',
  'INSURANCE_EXPIRED',
  'LICENSE_EXPIRED',
  'DRIVER_HAS_ACTIVE_RIDE',

  // Rattachement du numéro de téléphone
  'PHONE_ALREADY_VERIFIED',
  'PHONE_NOT_VERIFIED',
  'OTP_INVALID',
  'OTP_EXPIRED',

  // Estimation
  'QUOTE_EXPIRED',
  'QUOTE_NOT_FOUND',
  'PROMO_CODE_INVALID',
  // L2-05 : indisponibilité de l'API de routage -- jamais d'estimation dégradée silencieuse
  // (amoa/questions/L2-04.md).
  'ROUTE_UNAVAILABLE',

  // Cycle de vie de la course
  'RIDE_NOT_FOUND',
  'RIDE_INVALID_TRANSITION',
  'RIDE_NOT_OWNED',
  'NO_DRIVER_AVAILABLE',
  'DRIVER_ALREADY_TAKEN',
  'DRIVER_NOT_IN_PROPOSAL',
  'PROPOSAL_EXPIRED',
  'RATING_ALREADY_SUBMITTED',
  'RATING_NOT_ALLOWED',
  // Incident (L8-04) et partage de trajet (L8-03) : tous deux réservés à une course dont l'état
  // place effectivement le client et le chauffeur ensemble (assigned/in_progress) -- avant
  // l'affectation, personne n'est encore réuni ; après un état terminal, ce n'est plus "pendant".
  'RIDE_NOT_ACTIVE',

  // Caisse
  'CASH_LIMIT_REACHED',
  'SETTLEMENT_AMOUNT_MISMATCH',

  // Position et disponibilité
  'LOCATION_REQUIRED',

  // Documents chauffeur (L1-05)
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_NOT_OWNED',
  'DOCUMENT_TYPE_MISMATCH',
]);

export type ErrorCode = z.infer<typeof ErrorCode>;

/** Statut HTTP associé à chaque code — une seule projection possible par code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,

  INVALID_GOOGLE_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  UNAUTHORIZED: 401,
  DRIVER_NOT_APPROVED: 403,

  MOTORCYCLE_NOT_ASSIGNED: 403,
  INSURANCE_EXPIRED: 403,
  LICENSE_EXPIRED: 403,
  DRIVER_HAS_ACTIVE_RIDE: 409,

  PHONE_ALREADY_VERIFIED: 409,
  PHONE_NOT_VERIFIED: 403,
  OTP_INVALID: 400,
  OTP_EXPIRED: 410,

  QUOTE_EXPIRED: 410,
  QUOTE_NOT_FOUND: 404,
  PROMO_CODE_INVALID: 400,
  ROUTE_UNAVAILABLE: 503,

  RIDE_NOT_FOUND: 404,
  RIDE_INVALID_TRANSITION: 409,
  RIDE_NOT_OWNED: 403,
  NO_DRIVER_AVAILABLE: 404,
  DRIVER_ALREADY_TAKEN: 409,
  DRIVER_NOT_IN_PROPOSAL: 403,
  PROPOSAL_EXPIRED: 410,
  RATING_ALREADY_SUBMITTED: 409,
  RATING_NOT_ALLOWED: 403,
  RIDE_NOT_ACTIVE: 409,

  CASH_LIMIT_REACHED: 409,
  SETTLEMENT_AMOUNT_MISMATCH: 400,

  LOCATION_REQUIRED: 400,

  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_NOT_OWNED: 403,
  DOCUMENT_TYPE_MISMATCH: 400,
};

/** Description courte, pour la documentation générée et les messages par défaut. */
export const ERROR_DESCRIPTION: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "Le corps de la requête ne correspond pas au schéma attendu.",
  INTERNAL_ERROR: "Erreur inattendue côté serveur.",
  RATE_LIMITED: "Trop de requêtes ; réessayer après un délai.",

  INVALID_GOOGLE_TOKEN: "L'ID token Google est invalide, expiré, ou sa signature ne correspond à aucune clé publiée.",
  TOKEN_EXPIRED: "Le jeton applicatif a expiré ; utiliser /auth/refresh.",
  TOKEN_REVOKED: "Le jeton applicatif a été révoqué par /auth/logout.",
  UNAUTHORIZED: "En-tête Authorization manquant ou malformé.",
  DRIVER_NOT_APPROVED: "Le compte chauffeur n'est pas encore validé par le back-office.",

  MOTORCYCLE_NOT_ASSIGNED: "Aucune moto n'est affectée à ce chauffeur.",
  INSURANCE_EXPIRED: "L'assurance de la moto affectée a expiré.",
  LICENSE_EXPIRED: "Le permis de conduire du chauffeur a expiré.",
  DRIVER_HAS_ACTIVE_RIDE: "Le chauffeur ne peut pas se mettre hors ligne pendant une course.",

  PHONE_ALREADY_VERIFIED: "Un numéro est déjà rattaché et vérifié pour ce compte ; un seul OTP dans la vie du compte (01-architecture.md §5).",
  PHONE_NOT_VERIFIED: "Cette action nécessite un numéro de téléphone vérifié.",
  OTP_INVALID: "Le code OTP fourni ne correspond pas à celui envoyé.",
  OTP_EXPIRED: "Le code OTP a expiré ; relancer /phone/verify/start.",

  QUOTE_EXPIRED: "L'estimation a dépassé sa date d'expiration ; en redemander une.",
  QUOTE_NOT_FOUND: "Aucune estimation active pour cet identifiant.",
  PROMO_CODE_INVALID: "Le code promotionnel est inconnu, expiré, ou déjà épuisé.",
  ROUTE_UNAVAILABLE: "L'API de routage est indisponible ; réessayer plus tard (aucune estimation dégradée n'est produite).",

  RIDE_NOT_FOUND: "Aucune course pour cet identifiant.",
  RIDE_INVALID_TRANSITION: "La transition demandée n'est pas permise depuis l'état courant de la course (voir docs/contracts/ride-state-machine.md).",
  RIDE_NOT_OWNED: "Cette course n'appartient pas à l'appelant.",
  NO_DRIVER_AVAILABLE: "Aucun chauffeur disponible dans le rayon de recherche.",
  DRIVER_ALREADY_TAKEN: "Le chauffeur vient d'être réservé par un autre client (réservation atomique, L3-06).",
  DRIVER_NOT_IN_PROPOSAL: "Le chauffeur qui répond n'est pas celui de la proposition active de cette course.",
  PROPOSAL_EXPIRED: "Le délai d'acceptation de la proposition est dépassé.",
  RATING_ALREADY_SUBMITTED: "Cette course a déjà été notée.",
  RATING_NOT_ALLOWED: "Une course ne peut être notée qu'une fois encaissée (settled).",
  RIDE_NOT_ACTIVE: "Cette action n'est possible que pendant une course affectée ou en cours.",

  CASH_LIMIT_REACHED: "Cet encaissement dépasserait le plafond de caisse du chauffeur (D8).",
  SETTLEMENT_AMOUNT_MISMATCH: "Le montant déclaré ne correspond pas au montant dû.",

  LOCATION_REQUIRED: "Une position (latitude, longitude) est requise pour cette requête.",

  DOCUMENT_NOT_FOUND: "Aucun document chauffeur pour cet identifiant.",
  DOCUMENT_NOT_OWNED: "Ce document n'appartient pas à l'appelant, et l'appelant n'est pas gestionnaire.",
  DOCUMENT_TYPE_MISMATCH: "Le type MIME réel du fichier ne correspond pas au type déclaré.",
};

/** Enveloppe d'erreur commune à toutes les réponses non-2xx de l'API. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
