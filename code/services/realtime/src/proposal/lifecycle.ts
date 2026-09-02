import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionRegistry } from '../ws/auth';
import { reserveDriver, releaseDriver } from '../reservation/reserve';
import { resolve as resolveRideState, getState as getRideState } from '../ride/state';
import { proposalRideIdKey, proposalRecordKey } from './keys';
import { ProposalTimeoutTimers } from './timeout';
import { notifyDriverOfProposal, type ProposalNotifier } from './notify';
import { reportDriverAccepted, reportDriverRejected } from '../odoo/rides';
import { getDriverProfiles } from '../redis/driver-profiles';
import { startRideSession } from '../tracking/session';
import { getPosition } from '../redis/positions';
import { haversineDistanceMeters } from '../tracking/validation';

/**
 * Cycle de proposition (L3-07) : après une réservation réussie (L3-06), notifier le chauffeur,
 * attendre sa réponse dans le délai configuré, et traiter les trois issues -- acceptation, refus
 * explicite, expiration. C'est cette tâche qui pose le marqueur d'engagement à l'acceptation, EN
 * REMPLACEMENT de la réservation (D26, voir amoa/questions/REPONSES-2026-08-16-J7.md §2) : sans
 * lui, la réservation expirait en pleine course et le veilleur d'expiration remettait au pool un
 * chauffeur qui transportait un passager.
 *
 * Comme reserveDriver (L3-06), `propose` n'a aucun appelant de production ce soir : le câblage
 * Odoo -> temps réel (select-driver appelant la réservation) est une tâche dédiée, hors périmètre
 * (amoa/questions/L3-06.md, point 1). Cette classe est prête à être appelée par lui.
 */

export interface ProposalDetails {
  rideId: string;
  clientUserId: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  amount: number;
  distanceMeters: number;
  /**
   * D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1) : le numéro du client, transmis
   * par Odoo dès `reserve_and_propose` (`services/realtime_client.py`) -- Odoo le connaît déjà
   * (`client_user.partner_id.phone`), au même titre qu'`origin`/`destination`/`amount` ci-dessus.
   * Posé ici, dans le même enregistrement Redis que le reste de la proposition, précisément pour
   * rester lisible sans appel Odoo au moment de `accept()` -- la contrainte D49 (`proposal.accepted`
   * émis avant tout `await` sur Odoo ou le cache de profils) ne change pas avec ce champ.
   */
  clientPhoneNumber: string | null;
}

export type ProposeOutcome = { proposed: true; expiresAt: string } | { proposed: false };

/**
 * Ce qui est réellement écrit dans `proposalRecordKey` : le détail de la proposition, plus trois
 * champs que seule cette écriture connaît et qu'une resynchronisation devra restituer (L7-04) --
 *
 * - `expiresAt` : la **véritable** échéance d'acceptation (`Date.now() +
 *   PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS`). Stockée explicitement, jamais redérivée du TTL Redis de
 *   `proposalRideIdKey` : ce TTL est `RESERVATION_TTL_SECONDS`, une durée VOISINE mais distincte
 *   (marge de sécurité qui doit survivre au minuteur JS, voir config.ts `.refine`). Prendre l'une
 *   pour l'autre donnerait un compte à rebours « honnête » honnêtement faux -- trente-cinq
 *   secondes affichées quand il en reste vingt.
 * - `emittedAt` : l'instant d'émission d'origine, pour le délai d'acheminement (`proposal.seen`,
 *   critère 4) mesuré même quand l'app n'a jamais reçu `proposal.new`.
 * - `distanceToOriginMeters` : calculée une fois à l'émission depuis la position Redis du chauffeur
 *   (D51) -- une resynchronisation ne la recalcule pas (la position a pu bouger, ou expirer).
 */
interface StoredProposal extends ProposalDetails {
  expiresAt: string;
  emittedAt: string;
  distanceToOriginMeters: number | null;
}

/**
 * Décision et écriture dans le MÊME script Lua (`ride/state.lua`, action `resolve`, L3-18) :
 * aucune condition en TypeScript entre la lecture de l'état d'une proposition et sa résolution.
 * Un driverId passe par ici trois fois au plus dans la vie d'une proposition -- acceptation,
 * refus, ou expiration -- et une seule de ces trois peut jamais réussir (critères 4 et 5).
 */
async function resolveProposal(
  redis: Redis,
  driverId: string,
  expectedRideId: string | null,
  outcome: 'accepted' | 'released'
): Promise<boolean> {
  return resolveRideState(redis, driverId, expectedRideId, outcome === 'accepted');
}

export class ProposalLifecycle {
  private readonly timers = new ProposalTimeoutTimers();

  constructor(
    private readonly config: Config,
    private readonly redis: Redis,
    private readonly registry: ConnectionRegistry,
    /**
     * Notification push haute priorité, émise EN PARALLÈLE de `proposal.new` (L7-04, critère 1 --
     * jamais à sa place). Injectable pour les tests ; en production c'est `notifyDriverOfProposal`
     * (délègue à Odoo, qui porte l'unique émetteur FCM et le registre de jetons -- invariant 1).
     */
    private readonly notifier: ProposalNotifier = notifyDriverOfProposal
  ) {}

  /**
   * Après réservation réussie (L3-06), enregistre la proposition et émet `proposal.new` au
   * chauffeur -- départ, arrivée, montant, distance, délai restant (spécification L3-07). Si le
   * chauffeur n'est pas connecté, la notification push (L7-04) reste à faire : hors périmètre de
   * cette tâche, ce soir seule l'émission WebSocket est câblée.
   */
  async propose(driverId: string, details: ProposalDetails): Promise<ProposeOutcome> {
    const reservation = await reserveDriver(this.redis, driverId, this.config.RESERVATION_TTL_SECONDS);
    if (!reservation.reserved) {
      return { proposed: false };
    }

    const emittedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS * 1000).toISOString();

    // D51 (31 août) : distance à vide jusqu'au client -- calculée ici depuis la position du
    // chauffeur (le même geo-index qui vient de le faire apparaître dans nearby.drivers), pas
    // recalculée côté app depuis une position GPS locale qui aurait pu bouger entre la sélection
    // et l'affichage. `null` si la position n'est plus lisible à cet instant : la proposition
    // part quand même (même raisonnement que le profil chauffeur pour `ride.assigned`, D30).
    const driverPosition = await getPosition(this.redis, driverId);
    const distanceToOriginMeters = driverPosition
      ? Math.round(haversineDistanceMeters(driverPosition, details.origin))
      : null;

    // Enregistrement enrichi (L7-04) : `expiresAt`/`emittedAt`/`distanceToOriginMeters` en plus du
    // détail, pour qu'une resynchronisation (`peekActiveProposal`) restitue une proposition
    // qu'aucun `proposal.new` n'a jamais atteinte -- app fermée, ouverte depuis la notification.
    const stored: StoredProposal = { ...details, expiresAt, emittedAt, distanceToOriginMeters };

    await Promise.all([
      this.redis.set(proposalRideIdKey(driverId), details.rideId, 'EX', this.config.RESERVATION_TTL_SECONDS),
      this.redis.set(proposalRecordKey(driverId), JSON.stringify(stored), 'EX', this.config.RESERVATION_TTL_SECONDS),
    ]);

    this.sendToDriver(driverId, {
      type: 'proposal.new',
      id: randomUUID(),
      emittedAt,
      payload: {
        rideId: details.rideId,
        origin: details.origin,
        destination: details.destination,
        amount: details.amount,
        distanceMeters: details.distanceMeters,
        distanceToOriginMeters,
        expiresAt,
      },
    });

    // Notification push EN PARALLÈLE du message WebSocket, jamais à sa place (L7-04, critère 1) :
    // si le chauffeur est connecté, le WebSocket arrive en premier et l'app ignore la notification
    // redondante (déduplication par identifiant de proposition, côté app). S'il ne l'est pas,
    // c'est le seul canal qui l'atteint. Non bloquant -- une notification perdue ne bloque aucun
    // parcours (L7-06), et un envoi lent ne doit pas retarder la réservation.
    this.notifier(this.config, { driverId, rideId: details.rideId, expiresAt });

    this.timers.schedule(driverId, this.config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS, () => {
      this.expire(driverId).catch(() => {
        // Filet défensif, même politique que le reste du service (ws/connection.ts) : une panne
        // Redis passagère ici ne doit jamais faire planter le processus.
      });
    });

    return { proposed: true, expiresAt };
  }

  /**
   * Annule une proposition tout juste posée (L3-17, critère 4) : appelée par
   * `http/internal.ts::/internal/reservations/release`, le chemin de compensation quand la
   * réservation côté temps réel a réussi mais que la transition Odoo `requested -> proposed` qui
   * devait suivre échoue -- sans ce nettoyage, le chauffeur resterait hors du pool jusqu'à
   * l'expiration de la réservation (`RESERVATION_TTL_SECONDS`), sans course correspondante nulle
   * part (même défaut que celui déjà couvert par `reserveDriver`/`releaseDriver`, critère 4 de
   * L3-06, une couche plus haut : à l'échelle du cycle de proposition entier plutôt que de la
   * seule réservation Redis).
   *
   * Idempotent : annuler une proposition déjà résolue (acceptée, refusée, expirée) ou déjà
   * annulée ne fait rien de plus qu'une tentative de relâchement sans effet visible.
   */
  async cancel(driverId: string): Promise<void> {
    this.timers.cancel(driverId);
    await Promise.all([this.redis.del(proposalRideIdKey(driverId)), this.redis.del(proposalRecordKey(driverId))]);
    await releaseDriver(this.redis, driverId);
  }

  /**
   * Acceptation (critères 1, 4, 5). `rideId` vient du message `proposal.accept` (C-02) -- une
   * donnée métier à faire correspondre à la proposition active, jamais une identité (celle-ci ne
   * vient que du contexte de connexion, invariant L3-01 ; `driverId` est déjà acquis par
   * l'appelant avant d'arriver ici, voir ws/dispatch.ts).
   */
  async accept(driverId: string, rideId: string): Promise<boolean> {
    this.timers.cancel(driverId);
    const resolved = await resolveProposal(this.redis, driverId, rideId, 'accepted');
    if (!resolved) return false;

    // D49 (31 août) + D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1) :
    // `consumeRecord` AVANT l'accusé de réception, pas après -- ce n'est qu'une lecture/suppression
    // Redis locale (déjà posée par `propose()`, jamais un appel Odoo), donc rester devant l'accusé
    // ne rouvre pas la contrainte D49 ("avant tout await sur Odoo ou le cache de profils") : c'est
    // précisément cette lecture Redis qui donne accès à `clientPhoneNumber` sans attendre Odoo.
    const record = await this.consumeRecord(driverId);

    // Accusé de réception au chauffeur, symétrique de `ride.assigned` au client ci-dessous. Émis
    // dès que la résolution atomique a réussi -- avant tout `await` sur Odoo ou le cache de
    // profils -- pour que `ProposalScreen` n'ait plus à inférer le succès d'un silence (écart
    // `amoa/questions/L6-12.md`). `clientPhoneNumber` à `null` si l'enregistrement a expiré entre
    // la résolution atomique et sa lecture (filet déjà existant) -- jamais bloquant (D30).
    this.sendToDriver(driverId, {
      type: 'proposal.accepted',
      id: randomUUID(),
      emittedAt: new Date().toISOString(),
      payload: { rideId, clientPhoneNumber: record?.clientPhoneNumber ?? null },
    });

    // Sens temps réel -> Odoo (L3-17) : écrit la transition proposed -> assigned. Volontairement
    // non attendu -- voir odoo/rides.ts pour le raisonnement complet -- la résolution Redis
    // ci-dessus fait déjà foi pour les deux parties connectées.
    reportDriverAccepted(this.config, rideId, driverId);

    if (record) {
      // L3-09 : pose l'association course/client/chauffeur que le suivi (`ride.track`) exige --
      // sans elle, rien ne permet de vérifier qu'un client suit une course qui est la sienne, ni
      // de savoir quel chauffeur suivre. Avant `sendToClient` : si le client se réabonne au
      // suivi dès la réception de `ride.assigned`, la session doit déjà exister.
      await startRideSession(this.redis, record.rideId, {
        clientUserId: record.clientUserId,
        driverId,
        origin: record.origin,
      });

      // D41 (amoa/questions/REPONSES-2026-08-25.md §2) : de quoi reconnaître la moto qui arrive
      // -- prénom, photo, gamme, ET immatriculation, celle-ci pour la première fois puisque
      // `nearby.drivers` ne l'a jamais portée (C2b, projection.ts ne la lit pas). Même cache que
      // `nearby.drivers` (redis/driver-profiles.ts) : un profil pas encore synchronisé dégrade
      // en `null`, ne retarde ni ne bloque l'envoi de `ride.assigned` (même raisonnement que
      // D30, étendu de la disponibilité d'un chauffeur à la confirmation d'une affectation).
      const profiles = await getDriverProfiles(this.config, this.redis, [driverId]);
      const profile = profiles.get(driverId) ?? null;
      this.sendToClient(record.clientUserId, {
        type: 'ride.assigned',
        id: randomUUID(),
        emittedAt: new Date().toISOString(),
        payload: {
          rideId: record.rideId,
          driverId,
          firstName: profile?.firstName ?? null,
          photoUrl: profile?.photoUrl ?? null,
          motorcycleClass: profile?.motorcycleClass ?? null,
          licensePlate: profile?.licensePlate ?? null,
          phoneNumber: profile?.phoneNumber ?? null,
        },
      });
    }
    return true;
  }

  /** Refus explicite (critère 2) : libère le chauffeur et notifie le client, motif distinct de
   * l'expiration (le distinguo lui-même est porté par l'appelant, voir ws/dispatch.ts). Le motif
   * (message `proposal.reject`, C-02, optionnel) est désormais transmis à Odoo (L3-17) --
   * auparavant recueilli puis jamais utilisé nulle part. */
  async reject(driverId: string, rideId: string, reason?: string): Promise<boolean> {
    this.timers.cancel(driverId);
    const resolved = await resolveProposal(this.redis, driverId, rideId, 'released');
    if (!resolved) return false;

    await releaseDriver(this.redis, driverId);
    reportDriverRejected(this.config, rideId, driverId, { expired: false, reason });
    const record = await this.consumeRecord(driverId);
    if (record) {
      this.sendToClient(record.clientUserId, {
        type: 'ride.rejected',
        id: randomUUID(),
        emittedAt: new Date().toISOString(),
        payload: { rideId: record.rideId, driverId, reason: 'driver_rejected' },
      });
    }
    return true;
  }

  /** Expiration système (critère 3) : même effet qu'un refus, motif distinct. Aucune vérification
   * de rideId ici -- ce minuteur ne représente jamais qu'une seule proposition à la fois pour ce
   * chauffeur (voir ProposalTimeoutTimers), la résolution atomique reste le seul arbitre en cas de
   * course avec une acceptation concurrente. */
  private async expire(driverId: string): Promise<void> {
    const resolved = await resolveProposal(this.redis, driverId, null, 'released');
    if (!resolved) return;

    await releaseDriver(this.redis, driverId);
    const record = await this.consumeRecord(driverId);
    if (record) {
      reportDriverRejected(this.config, record.rideId, driverId, { expired: true });
      this.sendToClient(record.clientUserId, {
        type: 'ride.rejected',
        id: randomUUID(),
        emittedAt: new Date().toISOString(),
        payload: { rideId: record.rideId, driverId, reason: 'driver_timeout' },
      });
      this.sendToDriver(driverId, {
        type: 'proposal.expired',
        id: randomUUID(),
        emittedAt: new Date().toISOString(),
        payload: { rideId: record.rideId },
      });
    }
  }

  private async consumeRecord(driverId: string): Promise<StoredProposal | null> {
    const raw = await this.redis.get(proposalRecordKey(driverId));
    if (!raw) return null;
    await this.redis.del(proposalRecordKey(driverId));
    return JSON.parse(raw) as StoredProposal;
  }

  /**
   * Proposition active de ce chauffeur, restituée à une resynchronisation (L7-04, `ws/resync.ts`)
   * -- SANS la consommer, contrairement à `consumeRecord` : une resynchronisation relit, elle ne
   * résout pas. `null` quand il n'y en a pas *ou* qu'elle est déjà échue -- l'absence se dit
   * explicitement (`session.synced.activeProposal: null`), jamais déduite d'un silence.
   *
   * Trois gardes : le record doit exister, l'état de course du chauffeur doit toujours être
   * `reserved` (une acceptation le fait passer `engaged` dans le même script Lua ; un refus ou
   * une expiration l'efface -- `proposalRecordKey`, lui, n'est effacé qu'ensuite, à un `await`
   * près : lire l'état referme cette fenêtre), et `expiresAt` ne doit pas être échu. Une
   * notification ouverte vingt secondes trop tard n'affiche donc pas des boutons pour une course
   * qui n'est plus à prendre (critère 3).
   */
  async peekActiveProposal(
    driverId: string,
    nowMs: number = Date.now()
  ): Promise<realtime.ActiveProposal | null> {
    const [raw, state] = await Promise.all([
      this.redis.get(proposalRecordKey(driverId)),
      getRideState(this.redis, driverId),
    ]);
    if (!raw || state !== 'reserved') return null;

    const stored = JSON.parse(raw) as StoredProposal;
    if (Date.parse(stored.expiresAt) <= nowMs) return null;

    return {
      rideId: stored.rideId,
      origin: stored.origin,
      destination: stored.destination,
      amount: stored.amount,
      distanceMeters: stored.distanceMeters,
      distanceToOriginMeters: stored.distanceToOriginMeters,
      expiresAt: stored.expiresAt,
      emittedAt: stored.emittedAt,
    };
  }

  private sendToDriver(driverId: string, message: realtime.ServerToClientMessage): void {
    this.send(this.registry.getByDriverId(driverId), message);
  }

  private sendToClient(userId: string, message: realtime.ServerToClientMessage): void {
    this.send(this.registry.getByUserId(userId), message);
  }

  private send(sockets: ReadonlySet<WebSocket>, message: realtime.ServerToClientMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}
