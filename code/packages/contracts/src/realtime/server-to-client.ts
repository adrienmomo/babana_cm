import { z } from 'zod';
import { envelopeSchema } from './envelope';
import { LatLngSchema, MoneyAmountSchema, RideIdSchema, DriverIdSchema, IsoDateTimeSchema } from '../http/common';
import { NearbyDriverSchema } from '../http/driver';
import { RideStateSchema } from '../http/ride';

/**
 * Tous les messages émis DEPUIS le serveur, à destination de l'application Chauffeur ou de
 * l'application Client (même convention de regroupement que client-to-server.ts).
 */

// --- Serveur vers chauffeur ----------------------------------------------------------------

/** Destinataire : chauffeur. Nouvelle proposition (transition requested/rejected -> proposed). */
export const ProposalNewPayloadSchema = z.object({
  rideId: RideIdSchema,
  origin: LatLngSchema,
  destination: LatLngSchema,
  amount: MoneyAmountSchema,
  distanceMeters: z.number().int().nonnegative(),
  expiresAt: IsoDateTimeSchema,
});
export const ProposalNewMessageSchema = envelopeSchema('proposal.new', ProposalNewPayloadSchema);
export type ProposalNewMessage = z.infer<typeof ProposalNewMessageSchema>;

/** Destinataire : chauffeur. Le délai d'acceptation a expiré sans réponse (transition proposed -> rejected). */
export const ProposalExpiredPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const ProposalExpiredMessageSchema = envelopeSchema('proposal.expired', ProposalExpiredPayloadSchema);
export type ProposalExpiredMessage = z.infer<typeof ProposalExpiredMessageSchema>;

/**
 * Destinataire : chauffeur ou client, selon la connexion à laquelle le serveur choisit de le
 * pousser — un seul type de message, un seul émetteur (le serveur), simplement délivré aux
 * deux rôles concernés par la course annulée. Le critère d'acceptation 1 de C-02 porte sur
 * l'émetteur (client vs serveur), pas sur le nombre de destinataires possibles.
 */
export const RideCancelledPayloadSchema = z.object({
  rideId: RideIdSchema,
  reason: z.string().max(280).optional(),
});
export const RideCancelledMessageSchema = envelopeSchema('ride.cancelled', RideCancelledPayloadSchema);
export type RideCancelledMessage = z.infer<typeof RideCancelledMessageSchema>;

/** Destinataire : chauffeur. Avertissement avant CASH_LIMIT_REACHED (D8). */
export const CashLimitWarningPayloadSchema = z.object({
  balance: MoneyAmountSchema,
  limit: MoneyAmountSchema,
});
export const CashLimitWarningMessageSchema = envelopeSchema('cash.limit.warning', CashLimitWarningPayloadSchema);
export type CashLimitWarningMessage = z.infer<typeof CashLimitWarningMessageSchema>;

// --- Serveur vers client (passager) --------------------------------------------------------

/**
 * Destinataire : client. Réponse à nearby.subscribe, puis mises à jour périodiques.
 * Réutilise NearbyDriverSchema de C-01 (GET /drivers/nearby) : même forme, même garde-fou
 * .strict(), une seule définition pour la règle « aucune donnée personnelle au-delà du
 * prénom, de la photo, de la note et de la gamme de moto » (critère d'acceptation 3).
 */
export const NearbyDriversPayloadSchema = z.object({
  drivers: z.array(NearbyDriverSchema).max(5),
});
export const NearbyDriversMessageSchema = envelopeSchema('nearby.drivers', NearbyDriversPayloadSchema);
export type NearbyDriversMessage = z.infer<typeof NearbyDriversMessageSchema>;

/** Destinataire : client. Le chauffeur sélectionné a été réservé (transition -> proposed). */
export const RideProposedPayloadSchema = z.object({
  rideId: RideIdSchema,
  driverId: DriverIdSchema,
  proposalExpiresAt: IsoDateTimeSchema,
});
export const RideProposedMessageSchema = envelopeSchema('ride.proposed', RideProposedPayloadSchema);
export type RideProposedMessage = z.infer<typeof RideProposedMessageSchema>;

/** Destinataire : client. Le chauffeur a accepté (transition -> assigned). */
export const RideAssignedPayloadSchema = z.object({
  rideId: RideIdSchema,
  driverId: DriverIdSchema,
});
export const RideAssignedMessageSchema = envelopeSchema('ride.assigned', RideAssignedPayloadSchema);
export type RideAssignedMessage = z.infer<typeof RideAssignedMessageSchema>;

/** Destinataire : client. Le chauffeur a refusé, ou le délai a expiré (transition -> rejected). */
export const RideRejectedPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const RideRejectedMessageSchema = envelopeSchema('ride.rejected', RideRejectedPayloadSchema);
export type RideRejectedMessage = z.infer<typeof RideRejectedMessageSchema>;

/** Destinataire : client. Suivi de position pendant une course affectée ou en cours. */
export const DriverPositionPayloadSchema = z.object({
  rideId: RideIdSchema,
  position: LatLngSchema,
});
export const DriverPositionMessageSchema = envelopeSchema('driver.position', DriverPositionPayloadSchema);
export type DriverPositionMessage = z.infer<typeof DriverPositionMessageSchema>;

/** Destinataire : client. Transition -> in_progress. */
export const RideStartedPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const RideStartedMessageSchema = envelopeSchema('ride.started', RideStartedPayloadSchema);
export type RideStartedMessage = z.infer<typeof RideStartedMessageSchema>;

/** Destinataire : client. Transition -> completed. */
export const RideCompletedPayloadSchema = z.object({
  rideId: RideIdSchema,
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  amount: MoneyAmountSchema,
});
export const RideCompletedMessageSchema = envelopeSchema('ride.completed', RideCompletedPayloadSchema);
export type RideCompletedMessage = z.infer<typeof RideCompletedMessageSchema>;

// --- Politique de reconnexion (réponse du serveur, client et chauffeur) -------------------

/**
 * Destinataire : client ou chauffeur, en réponse à session.resync. Resynchronisation complète,
 * jamais un différentiel (politique de reconnexion, docs/contracts/realtime-events.md).
 */
export const SessionSyncedPayloadSchema = z.object({
  activeRideId: RideIdSchema.nullable(),
  activeRideState: RideStateSchema.nullable(),
  serverTime: IsoDateTimeSchema,
});
export const SessionSyncedMessageSchema = envelopeSchema('session.synced', SessionSyncedPayloadSchema);
export type SessionSyncedMessage = z.infer<typeof SessionSyncedMessageSchema>;

export const ServerToClientMessageSchema = z.discriminatedUnion('type', [
  ProposalNewMessageSchema,
  ProposalExpiredMessageSchema,
  RideCancelledMessageSchema,
  CashLimitWarningMessageSchema,
  NearbyDriversMessageSchema,
  RideProposedMessageSchema,
  RideAssignedMessageSchema,
  RideRejectedMessageSchema,
  DriverPositionMessageSchema,
  RideStartedMessageSchema,
  RideCompletedMessageSchema,
  SessionSyncedMessageSchema,
]);
export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>;
