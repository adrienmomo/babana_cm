import { z } from 'zod';
import { envelopeSchema } from './envelope';
import { LatLngSchema, MoneyAmountSchema, RideIdSchema, DriverIdSchema, IsoDateTimeSchema } from '../http/common';
import { NearbyDriverSchema } from '../http/driver';
import { RideStateSchema } from '../http/ride';
import { FareBreakdownSchema, VehicleClassSchema } from '../http/quote';

/**
 * Tous les messages émis DEPUIS le serveur, à destination de l'application Chauffeur ou de
 * l'application Client (même convention de regroupement que client-to-server.ts).
 */

// --- Serveur vers chauffeur ----------------------------------------------------------------

/** Destinataire : chauffeur. Nouvelle proposition (transition requested/rejected -> proposed). */
/**
 * `distanceMeters` est la distance de la **course** (départ -> arrivée, celle qui sert au tarif,
 * D15/L2-05). `distanceToOriginMeters` (D51, 31 août -- amoa/questions/REPONSES-2026-08-31.md §3 ;
 * écart d'origine `amoa/questions/L6-11.md`) est la distance à vol d'oiseau que le chauffeur doit
 * parcourir **à vide** pour rejoindre le client -- le serveur la connaît, il vient de trier les
 * cinq plus proches. Pour quelqu'un qui décide en trente secondes c'est souvent le chiffre le plus
 * déterminant : une course à 500 FCFA qui demande trois kilomètres à vide n'est pas la même
 * affaire. Approximation présentée comme telle (Haversine, jamais un itinéraire -- É8, aucun
 * routage deux-roues au Cameroun), même honnêteté que la distance de `nearby.drivers` et l'ETA de
 * `driver.position`. `null` si la position du chauffeur n'est pas lisible à cet instant précis
 * (TTL expiré entre la sélection et la réservation) -- ne bloque jamais l'envoi de la proposition
 * (même raisonnement que D30 pour le profil chauffeur).
 */
export const ProposalNewPayloadSchema = z.object({
  rideId: RideIdSchema,
  origin: LatLngSchema,
  destination: LatLngSchema,
  amount: MoneyAmountSchema,
  distanceMeters: z.number().int().nonnegative(),
  distanceToOriginMeters: z.number().int().nonnegative().nullable(),
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
 * Destinataire : chauffeur. Son `proposal.accept` a été résolu atomiquement en sa faveur
 * (transition proposed -> assigned) -- symétrique de `ride.assigned` côté client (D49, 31 août,
 * amoa/questions/REPONSES-2026-08-31.md §2 ; écart d'origine `amoa/questions/L6-12.md`). Avant
 * ce message, `ProposalScreen` ne connaissait que les issues négatives (`proposal.expired`) et
 * devait inférer le succès d'un silence -- un délai de grâce deviné (1500 ms), jamais calibré,
 * toujours trop court ou trop long sur un réseau de Douala. Émis au même point que
 * `ride.assigned` (`proposal/lifecycle.ts::accept`, juste après le succès de `resolveProposal`) :
 * toute action émise sur le fil reçoit une réponse, positive ou négative.
 */
export const ProposalAcceptedPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const ProposalAcceptedMessageSchema = envelopeSchema('proposal.accepted', ProposalAcceptedPayloadSchema);
export type ProposalAcceptedMessage = z.infer<typeof ProposalAcceptedMessageSchema>;

/**
 * Destinataire : chauffeur ou client, selon la connexion à laquelle le serveur choisit de le
 * pousser — un seul type de message, un seul émetteur (le serveur), simplement délivré aux
 * rôles concernés par la course annulée. Le critère d'acceptation 1 de C-02 porte sur
 * l'émetteur (client vs serveur), pas sur le nombre de destinataires possibles.
 *
 * `cancelledBy` (L4-12, amoa/questions/REPONSES-2026-08-28.md §2) : le destinataire dépend de
 * l'acteur -- un client qui annule prévient le chauffeur, un chauffeur prévient le client, un
 * superviseur prévient les deux (jamais celui qui vient de décider, qui le sait déjà). Sans ce
 * champ, un chauffeur qui apprend qu'une course est annulée ne peut pas distinguer un client qui
 * a changé d'avis d'une annulation par supervision -- le minimum pour ne pas rouler pour rien
 * vers un point de prise en charge qui n'existe plus.
 */
export const RideCancelledPayloadSchema = z.object({
  rideId: RideIdSchema,
  cancelledBy: z.enum(['client', 'driver', 'supervisor']),
  reason: z.string().max(280).optional(),
});
export const RideCancelledMessageSchema = envelopeSchema('ride.cancelled', RideCancelledPayloadSchema);
export type RideCancelledMessage = z.infer<typeof RideCancelledMessageSchema>;

// --- Serveur vers client (passager) --------------------------------------------------------

/**
 * Destinataire : client. Réponse à nearby.subscribe, puis mises à jour périodiques.
 * Réutilise NearbyDriverSchema (`http/driver.ts`) : même forme, même garde-fou .strict(), une
 * seule définition pour la règle « aucune donnée personnelle au-delà du prénom, de la photo, de
 * la note et de la gamme de moto » (critère d'acceptation 3). `GET /drivers/nearby` en partageait
 * la forme avant d'être retiré du contrat, jamais implémenté (`amoa/questions/C-01R.md` §1) --
 * nearby.drivers est désormais le seul chemin de découverte des chauffeurs proches.
 */
export const NearbyDriversPayloadSchema = z.object({
  drivers: z.array(NearbyDriverSchema).max(5),
});
export const NearbyDriversMessageSchema = envelopeSchema('nearby.drivers', NearbyDriversPayloadSchema);
export type NearbyDriversMessage = z.infer<typeof NearbyDriversMessageSchema>;

/**
 * Destinataire : client. Accusé de réception de `nearby.subscribe` -- accepté, ou refusé pour
 * limitation de débit avec un délai avant nouvelle tentative (L3-05 / L6-06, 23 août --
 * amoa/questions/REPONSES-2026-08-23.md §2). Avant cet accusé, un abonnement refusé ne
 * produisait rien : un client qui insiste sur « Réessayer » pouvait cesser d'être servi sans
 * qu'aucun élément ne le lui dise -- un silence est le pire retour possible pour une limitation
 * de débit, il pousse exactement au comportement qui l'aggrave.
 */
/**
 * `broadcastIntervalMs` (D50, 31 août -- amoa/questions/REPONSES-2026-08-31.md §2) : la cadence
 * réelle de la diffusion `nearby.drivers` qui va suivre, annoncée par le serveur au moment où il
 * l'accepte. L'application n'a plus de copie locale de `NEARBY_BROADCAST_INTERVAL_SECONDS` à tenir
 * d'accord avec la base -- elle apprend du serveur à quel rythme les messages arrivent, donc à
 * partir de quand un silence est anormal (surveillance L3-20). Deux copies d'une même valeur sans
 * mécanisme pour les tenir d'accord finissent par diverger en silence (D23 sous un autre costume).
 * Absent d'un refus : sans diffusion à venir, il n'y a pas de cadence à annoncer.
 */
export const NearbySubscribeAckPayloadSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), broadcastIntervalMs: z.number().int().positive() }),
  z.object({ accepted: z.literal(false), retryAfterMs: z.number().int().positive() }),
]);
export const NearbySubscribeAckMessageSchema = envelopeSchema('nearby.subscribe.ack', NearbySubscribeAckPayloadSchema);
export type NearbySubscribeAckMessage = z.infer<typeof NearbySubscribeAckMessageSchema>;

/**
 * Destinataire : client. Accusé de réception de `ride.track` (D50, 31 août) -- porte la cadence
 * réelle de la diffusion `driver.position` qui va suivre, même rôle que `broadcastIntervalMs`
 * dans `nearby.subscribe.ack` ci-dessus. Avant ce message, `TrackingScreen` tenait une copie
 * locale de `TRACKING_BROADCAST_INTERVAL_SECONDS`, sans aucun moyen de la garder d'accord avec la
 * valeur serveur. Émis à chaque `ride.track` accepté, y compris un réabonnement après reconnexion
 * -- l'application relit alors la cadence courante plutôt que de supposer qu'elle n'a pas changé.
 */
export const RideTrackAckPayloadSchema = z.object({
  broadcastIntervalMs: z.number().int().positive(),
});
export const RideTrackAckMessageSchema = envelopeSchema('ride.track.ack', RideTrackAckPayloadSchema);
export type RideTrackAckMessage = z.infer<typeof RideTrackAckMessageSchema>;

/**
 * Destinataire : client. Le chauffeur sélectionné a été réservé (transition -> proposed).
 *
 * Redondant pour l'appareil qui a fait la demande : `POST /rides/{id}/select-driver`
 * (`SelectDriverResponse.state`, `controllers/ride.py`) le lui apprend déjà de façon synchrone,
 * dans la réponse HTTP elle-même. Ce message garde son rôle pour **un second appareil du même
 * client** -- un téléphone se partage en famille à Douala, et la personne qui commande n'est pas
 * toujours celle qui voyage (amoa/questions/REPONSES-2026-08-28.md §1). Gardé au contrat
 * pour cette raison, contrairement à `ride.start`/`ride.complete`/`cash.limit.warning`, retirés
 * le même soir faute de tout rôle réel.
 */
export const RideProposedPayloadSchema = z.object({
  rideId: RideIdSchema,
  driverId: DriverIdSchema,
  proposalExpiresAt: IsoDateTimeSchema,
});
export const RideProposedMessageSchema = envelopeSchema('ride.proposed', RideProposedPayloadSchema);
export type RideProposedMessage = z.infer<typeof RideProposedMessageSchema>;

/**
 * Destinataire : client. Le chauffeur a accepté (transition -> assigned).
 *
 * `firstName`/`photoUrl`/`motorcycleClass`/`licensePlate` ajoutés le 25 août (D41,
 * amoa/questions/REPONSES-2026-08-25.md §2) : de quoi reconnaître la moto qui arrive. Avant
 * l'affectation, rien de tout cela ne quitte le serveur pour ce client — `nearby.drivers`
 * (précédent, ci-dessus) reste la seule vue disponible, et son schéma n'a pas changé :
 * `licensePlate` en particulier n'y figure toujours pas (C2b, la flotte ne doit pas être
 * balayable par un client qui ne fait que regarder). C'est le choix du client qui fait basculer
 * la sensibilité de la même donnée — ce client-là a choisi ce chauffeur-là.
 *
 * Nullable, même raison que `NearbyDriverSchema` (D30) : un profil chauffeur qu'Odoo n'a jamais
 * fini de synchroniser ne doit jamais retarder ni bloquer l'envoi de `ride.assigned` — la
 * confirmation de l'affectation elle-même ne dépend d'aucun de ces quatre champs.
 */
export const RideAssignedPayloadSchema = z.object({
  rideId: RideIdSchema,
  driverId: DriverIdSchema,
  firstName: z.string().nullable(),
  photoUrl: z.string().url().nullable(),
  motorcycleClass: VehicleClassSchema.nullable(),
  licensePlate: z.string().nullable(),
});
export const RideAssignedMessageSchema = envelopeSchema('ride.assigned', RideAssignedPayloadSchema);
export type RideAssignedMessage = z.infer<typeof RideAssignedMessageSchema>;

/**
 * Destinataire : client. Le chauffeur a refusé, ou le délai a expiré (transition -> rejected).
 * `driverId` et `reason` ajoutés le 23 août (L6-08, amoa/questions/L3-07.md) : la première
 * rédaction ne portait que `rideId`, alors que L3-07 (critère 2) promet déjà au client "un motif
 * distinct de l'expiration" et que L6-08 doit écarter précisément ce chauffeur de la liste
 * réaffichée -- deux informations que le client ne pouvait pas obtenir de ce message.
 */
export const RideRejectedPayloadSchema = z.object({
  rideId: RideIdSchema,
  driverId: DriverIdSchema,
  reason: z.enum(['driver_rejected', 'driver_timeout']),
});
export const RideRejectedMessageSchema = envelopeSchema('ride.rejected', RideRejectedPayloadSchema);
export type RideRejectedMessage = z.infer<typeof RideRejectedMessageSchema>;

/**
 * Destinataire : client. Suivi de position pendant une course affectée ou en cours (L3-09).
 *
 * `position` est en précision réelle ici, contrairement à `nearby.drivers` (L3-05) : une fois la
 * course affectée, le client a le droit de savoir où est le chauffeur qui vient le chercher --
 * l'arrondi de C2b ne protège plus rien qui vaille pour cette course-là.
 *
 * `etaSeconds` : distance à vol d'oiseau jusqu'au point de prise en charge, convertie par une
 * vitesse moyenne plausible (config, jamais codée en dur) -- pas un temps de trajet routier
 * (aucun service de routage accessible depuis le service temps réel, D3). Même honnêteté que la
 * distance de `nearby.drivers` : une approximation présentée comme telle, jamais une fausse
 * précision.
 */
export const DriverPositionPayloadSchema = z.object({
  rideId: RideIdSchema,
  position: LatLngSchema,
  etaSeconds: z.number().int().nonnegative(),
});
export const DriverPositionMessageSchema = envelopeSchema('driver.position', DriverPositionPayloadSchema);
export type DriverPositionMessage = z.infer<typeof DriverPositionMessageSchema>;

/** Destinataire : client. Transition -> in_progress. */
export const RideStartedPayloadSchema = z.object({
  rideId: RideIdSchema,
});
export const RideStartedMessageSchema = envelopeSchema('ride.started', RideStartedPayloadSchema);
export type RideStartedMessage = z.infer<typeof RideStartedMessageSchema>;

/**
 * Destinataire : client. Transition -> completed.
 *
 * `breakdown` ajouté le 25 août (amoa/questions/REPONSES-2026-08-25.md §2) : le résumé de fin
 * est ce qu'un client relira en cas de litige, il doit être ce que le serveur a écrit — pas
 * seulement le montant total, pas ce que l'application aurait accumulé en route. Réutilise
 * `FareBreakdownSchema` de C-01 (`POST /quote`) : même détail décomposé, une seule définition
 * (D17) — le montant final de `POST /rides/{id}/complete` (L4-04) est celui de l'estimation
 * gelée à la création (L2-04), jamais recalculé, donc le même détail s'applique tel quel.
 */
export const RideCompletedPayloadSchema = z.object({
  rideId: RideIdSchema,
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  amount: MoneyAmountSchema,
  breakdown: FareBreakdownSchema,
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
  ProposalAcceptedMessageSchema,
  RideCancelledMessageSchema,
  NearbyDriversMessageSchema,
  NearbySubscribeAckMessageSchema,
  RideTrackAckMessageSchema,
  RideProposedMessageSchema,
  RideAssignedMessageSchema,
  RideRejectedMessageSchema,
  DriverPositionMessageSchema,
  RideStartedMessageSchema,
  RideCompletedMessageSchema,
  SessionSyncedMessageSchema,
]);
export type ServerToClientMessage = z.infer<typeof ServerToClientMessageSchema>;
