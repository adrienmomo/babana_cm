import { http } from '@babana/contracts';
import { reportMetric } from '../metrics';

export class ApiError extends Error {
  constructor(
    public readonly code: http.ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Une phrase en français par code du catalogue C-01 (L6-03, critère d'acceptation 4 ; D20 --
 * exigence non esthétique). Écrite une seule fois ici, pas dans chaque écran qui l'affiche :
 * quinze écrans qui traduisent chacun `DRIVER_ALREADY_TAKEN` à leur façon donnent quinze phrases
 * différentes. Compréhensible par quelqu'un qui n'a jamais utilisé d'application de transport --
 * ni jargon technique (« back-office », « idempotence »), ni code brut. Registre distinct
 * d'`ERROR_DESCRIPTION` (@babana/contracts) : celui-là documente le contrat pour un développeur,
 * celui-ci s'adresse à l'utilisateur final.
 *
 * `satisfies Record<http.ErrorCode, string>` : si le catalogue C-01 gagne un code, ce fichier ne
 * compile plus tant qu'il n'a pas sa phrase -- même discipline que les suites générées depuis des
 * données (CLAUDE.md, "un filet contre l'oubli, pas seulement contre l'erreur").
 */
export const USER_MESSAGES = {
  VALIDATION_ERROR: "Une information saisie n'est pas valide. Vérifiez et réessayez.",
  INTERNAL_ERROR: "Une erreur inattendue s'est produite. Réessayez dans un instant.",
  RATE_LIMITED: 'Trop de tentatives. Patientez un instant avant de réessayer.',

  INVALID_GOOGLE_TOKEN: 'La connexion avec Google a échoué. Réessayez.',
  TOKEN_EXPIRED: 'Votre session a expiré. Reconnectez-vous.',
  TOKEN_REVOKED: "Votre session n'est plus valide. Reconnectez-vous.",
  UNAUTHORIZED: 'Vous devez être connecté pour continuer.',
  DRIVER_NOT_APPROVED: 'Votre dossier chauffeur est en cours de validation.',

  MOTORCYCLE_NOT_ASSIGNED: "Aucune moto ne vous a encore été attribuée. Contactez l'assistance.",
  INSURANCE_EXPIRED: "L'assurance de votre moto a expiré. Contactez l'assistance.",
  LICENSE_EXPIRED: 'Votre permis de conduire a expiré. Contactez l\'assistance.',
  DRIVER_HAS_ACTIVE_RIDE: 'Impossible de vous mettre hors ligne pendant une course.',

  PHONE_ALREADY_VERIFIED: 'Ce numéro est déjà vérifié.',
  PHONE_NOT_VERIFIED: "Vous devez d'abord vérifier votre numéro de téléphone.",
  OTP_INVALID: 'Le code saisi est incorrect.',
  OTP_EXPIRED: 'Ce code a expiré. Demandez-en un nouveau.',

  QUOTE_EXPIRED: 'Cette estimation a expiré. Demandez-en une nouvelle.',
  QUOTE_NOT_FOUND: "Cette estimation n'est plus disponible.",
  PROMO_CODE_INVALID: "Ce code promotionnel n'est pas valide.",
  ROUTE_UNAVAILABLE: "Impossible de calculer l'itinéraire pour le moment. Réessayez.",

  RIDE_NOT_FOUND: "Cette course n'existe pas ou n'est plus disponible.",
  RIDE_INVALID_TRANSITION: "Cette action n'est plus possible pour cette course.",
  RIDE_NOT_OWNED: "Cette course ne vous appartient pas.",
  NO_DRIVER_AVAILABLE: "Aucun chauffeur n'est disponible pour le moment.",
  DRIVER_ALREADY_TAKEN: "Ce chauffeur vient d'être choisi par quelqu'un d'autre.",
  DRIVER_NOT_IN_PROPOSAL: 'Cette proposition ne vous concerne plus.',
  PROPOSAL_EXPIRED: 'Le délai pour répondre à cette proposition est dépassé.',
  RATING_ALREADY_SUBMITTED: 'Vous avez déjà noté cette course.',
  RATING_NOT_ALLOWED: 'Cette course ne peut pas encore être notée.',

  CASH_LIMIT_REACHED: "Votre plafond d'encaisse est atteint. Faites une remise pour continuer.",
  SETTLEMENT_AMOUNT_MISMATCH: "Le montant ne correspond pas à ce qui est attendu.",

  LOCATION_REQUIRED: 'Votre position est nécessaire pour continuer.',

  DOCUMENT_NOT_FOUND: "Ce document n'existe pas.",
  DOCUMENT_NOT_OWNED: "Ce document ne vous appartient pas.",
  DOCUMENT_TYPE_MISMATCH: "Le fichier envoyé ne correspond pas au type attendu.",
} satisfies Record<http.ErrorCode, string>;

const GENERIC_MESSAGE = "Une erreur inattendue s'est produite. Réessayez, ou contactez l'assistance si le problème persiste.";

/**
 * Traduit une `ApiError` en message affichable (critères 4 et 5). Un code absent du catalogue
 * C-01 -- normalement impossible côté serveur, mais une app plus ancienne qu'un serveur qui a
 * gagné un code n'est pas à exclure -- produit le message générique et une remontée technique,
 * jamais le code brut affiché à l'utilisateur.
 */
export function translateApiError(error: ApiError): string {
  const message = (USER_MESSAGES as Record<string, string | undefined>)[error.code];
  if (message) return message;
  reportMetric('api_client.unknown_error_code', { code: error.code });
  return GENERIC_MESSAGE;
}
