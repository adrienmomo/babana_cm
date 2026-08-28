import { z } from 'zod';
import { envelopeSchema } from './envelope';
import { DriverIdSchema, IsoDateTimeSchema, LatLngSchema, RideIdSchema } from '../http/common';

/**
 * Tous les messages émis VERS le serveur, qu'ils viennent de l'application Chauffeur ou de
 * l'application Client — "client" désigne ici l'application, pas le rôle passager (le fichier
 * regroupe donc les deux familles "Chauffeur vers serveur" et "Client vers serveur" de la
 * spécification C-02, qui ne prévoit que deux fichiers directionnels, pas quatre).
 *
 * Chaque message a un émetteur unique documenté en commentaire ; un serveur qui reçoit un
 * message d'un rôle qui n'est pas censé l'émettre le rejette (hors périmètre de ce contrat de
 * types, à appliquer côté service temps réel — L3-*).
 */

// --- Chauffeur vers serveur ---------------------------------------------------------------

/**
 * Un relevé de position, horodaté individuellement (L6-05) : nécessaire dès qu'un message peut
 * en porter plusieurs captés à des instants différents (`precedingSamples` ci-dessous) --
 * `capturedAt` de chacun, distinct de `emittedAt` de l'enveloppe qui est l'heure d'ENVOI du lot.
 */
export const PositionSampleSchema = z.object({
  ...LatLngSchema.shape,
  accuracyMeters: z.number().nonnegative(),
  speedMetersPerSecond: z.number().nonnegative().nullable(),
  headingDegrees: z.number().min(0).max(360).nullable(),
  capturedAt: IsoDateTimeSchema,
});
export type PositionSample = z.infer<typeof PositionSampleSchema>;

/**
 * Émetteur : chauffeur. Position GPS la plus récente, plus -- optionnellement -- les relevés
 * accumulés avant elle (L6-05, agrégation avant envoi) : un chauffeur en mouvement capte à une
 * fréquence adaptative mais n'envoie pas une requête par point ; les points captés entre deux
 * envois voyagent dans `precedingSamples`, dans l'ordre chronologique, jamais le point le plus
 * récent qui reste porté par les champs ci-dessus (jamais dupliqué).
 *
 * `precedingSamples` vide par défaut : un envoi non agrégé (un seul point, capté au moment de
 * l'envoi) reste un message valide sans rien y ajouter -- forme additive, compatible avec tout
 * appelant antérieur à L6-05 qui n'envoyait qu'un point par message.
 */
export const PositionUpdatePayloadSchema = z.object({
  ...LatLngSchema.shape,
  accuracyMeters: z.number().nonnegative(),
  speedMetersPerSecond: z.number().nonnegative().nullable(),
  headingDegrees: z.number().min(0).max(360).nullable(),
  precedingSamples: z.array(PositionSampleSchema).max(20).default([]),
});
export const PositionUpdateMessageSchema = envelopeSchema('position.update', PositionUpdatePayloadSchema);
export type PositionUpdateMessage = z.infer<typeof PositionUpdateMessageSchema>;

/** Émetteur : chauffeur. Bascule en ligne / hors ligne (D7). */
export const AvailabilitySetPayloadSchema = z.object({
  online: z.boolean(),
});
export const AvailabilitySetMessageSchema = envelopeSchema('availability.set', AvailabilitySetPayloadSchema);
export type AvailabilitySetMessage = z.infer<typeof AvailabilitySetMessageSchema>;

/** Émetteur : chauffeur. Répond à un proposal.new reçu du serveur. */
export const ProposalAcceptPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const ProposalAcceptMessageSchema = envelopeSchema('proposal.accept', ProposalAcceptPayloadSchema);
export type ProposalAcceptMessage = z.infer<typeof ProposalAcceptMessageSchema>;

/** Émetteur : chauffeur. */
export const ProposalRejectPayloadSchema = z.object({
  rideId: RideIdSchema,
  reason: z.string().max(280).optional(),
});
export const ProposalRejectMessageSchema = envelopeSchema('proposal.reject', ProposalRejectPayloadSchema);
export type ProposalRejectMessage = z.infer<typeof ProposalRejectMessageSchema>;

// --- Client (passager) vers serveur -------------------------------------------------------

/**
 * Émetteur : client. S'abonne aux mises à jour de la liste des chauffeurs proches.
 * `radiusMeters` est borné ici par un plafond de garde-fou anti-abus, pas par la valeur métier
 * du rayon de recherche réel — celle-ci reste configurable côté service temps réel (invariant 5).
 *
 * `excludeDriverIds` (L3-08, 24 août) : les chauffeurs qui ont déjà refusé CETTE course, portés
 * par le client depuis les `ride.rejected` déjà reçus (L6-08) -- pas une règle métier côté app,
 * seulement le report d'un fait que le serveur lui a lui-même appris. Le serveur décide seul de
 * la suite (exclusion, élargissement du rayon, seuil d'abandon) ; le client ne fait que rappeler
 * qui il a déjà vu refuser. Vide par défaut : une navigation initiale (accueil, première
 * estimation) n'exclut personne.
 */
export const NearbySubscribePayloadSchema = z.object({
  position: LatLngSchema,
  radiusMeters: z.number().positive().max(50_000),
  excludeDriverIds: z.array(DriverIdSchema).max(50).default([]),
});
export const NearbySubscribeMessageSchema = envelopeSchema('nearby.subscribe', NearbySubscribePayloadSchema);
export type NearbySubscribeMessage = z.infer<typeof NearbySubscribeMessageSchema>;

/** Émetteur : client. */
export const NearbyUnsubscribePayloadSchema = z.object({});
export const NearbyUnsubscribeMessageSchema = envelopeSchema('nearby.unsubscribe', NearbyUnsubscribePayloadSchema);
export type NearbyUnsubscribeMessage = z.infer<typeof NearbyUnsubscribeMessageSchema>;

/** Émetteur : client. S'abonne au suivi de position d'une course affectée ou en cours. */
export const RideTrackPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const RideTrackMessageSchema = envelopeSchema('ride.track', RideTrackPayloadSchema);
export type RideTrackMessage = z.infer<typeof RideTrackMessageSchema>;

// --- Politique de reconnexion (client et chauffeur) --------------------------------------

/**
 * Émetteur : client ou chauffeur, immédiatement après reconnexion, avant de rejouer la file
 * d'actions locale. `lastKnownRideId` permet au serveur de cibler la resynchronisation.
 */
export const SessionResyncPayloadSchema = z.object({
  lastKnownRideId: RideIdSchema.nullable(),
});
export const SessionResyncMessageSchema = envelopeSchema('session.resync', SessionResyncPayloadSchema);
export type SessionResyncMessage = z.infer<typeof SessionResyncMessageSchema>;

export const ClientToServerMessageSchema = z.discriminatedUnion('type', [
  PositionUpdateMessageSchema,
  AvailabilitySetMessageSchema,
  ProposalAcceptMessageSchema,
  ProposalRejectMessageSchema,
  NearbySubscribeMessageSchema,
  NearbyUnsubscribeMessageSchema,
  RideTrackMessageSchema,
  SessionResyncMessageSchema,
]);
export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;
