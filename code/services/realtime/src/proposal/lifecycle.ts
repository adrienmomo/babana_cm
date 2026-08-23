import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionRegistry } from '../ws/auth';
import { reserveDriver, releaseDriver, reservationKey } from '../reservation/reserve';
import { engagementKey } from '../driver/keys';
import { proposalRideIdKey, proposalRecordKey } from './keys';
import { ProposalTimeoutTimers } from './timeout';
import { reportDriverAccepted, reportDriverRejected } from '../odoo/rides';
import { getDriverProfiles } from '../redis/driver-profiles';

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

const RESOLVE_SCRIPT = readFileSync(path.join(__dirname, 'resolve.lua'), 'utf8');

export interface ProposalDetails {
  rideId: string;
  clientUserId: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  amount: number;
  distanceMeters: number;
}

export type ProposeOutcome = { proposed: true; expiresAt: string } | { proposed: false };

/**
 * Décision et écriture dans le MÊME script Lua (même discipline que reserve.lua, L3-06) : aucune
 * condition en TypeScript entre la lecture de l'état d'une proposition et sa résolution. Un
 * driverId passe par ici trois fois au plus dans la vie d'une proposition -- acceptation, refus,
 * ou expiration -- et une seule de ces trois peut jamais réussir (critères 4 et 5).
 */
async function resolveProposal(
  redis: Redis,
  driverId: string,
  expectedRideId: string | null,
  outcome: 'accepted' | 'released'
): Promise<boolean> {
  const result = await redis.eval(
    RESOLVE_SCRIPT,
    3,
    reservationKey(driverId),
    proposalRideIdKey(driverId),
    engagementKey(driverId),
    expectedRideId ?? '',
    outcome === 'accepted' ? '1' : '0'
  );
  return result === 1;
}

export class ProposalLifecycle {
  private readonly timers = new ProposalTimeoutTimers();

  constructor(
    private readonly config: Config,
    private readonly redis: Redis,
    private readonly registry: ConnectionRegistry
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

    const expiresAt = new Date(Date.now() + this.config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS * 1000).toISOString();

    await Promise.all([
      this.redis.set(proposalRideIdKey(driverId), details.rideId, 'EX', this.config.RESERVATION_TTL_SECONDS),
      this.redis.set(proposalRecordKey(driverId), JSON.stringify(details), 'EX', this.config.RESERVATION_TTL_SECONDS),
    ]);

    this.sendToDriver(driverId, {
      type: 'proposal.new',
      id: randomUUID(),
      emittedAt: new Date().toISOString(),
      payload: {
        rideId: details.rideId,
        origin: details.origin,
        destination: details.destination,
        amount: details.amount,
        distanceMeters: details.distanceMeters,
        expiresAt,
      },
    });

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

    // Sens temps réel -> Odoo (L3-17) : écrit la transition proposed -> assigned. Volontairement
    // non attendu -- voir odoo/rides.ts pour le raisonnement complet -- la résolution Redis
    // ci-dessus fait déjà foi pour les deux parties connectées.
    reportDriverAccepted(this.config, rideId, driverId);

    const record = await this.consumeRecord(driverId);
    if (record) {
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

  private async consumeRecord(driverId: string): Promise<ProposalDetails | null> {
    const raw = await this.redis.get(proposalRecordKey(driverId));
    if (!raw) return null;
    await this.redis.del(proposalRecordKey(driverId));
    return JSON.parse(raw) as ProposalDetails;
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
