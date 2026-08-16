import type Redis from 'ioredis';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { getPosition, storePosition } from '../redis/positions';
import { addEligibleToPool } from '../redis/pool-eligibility';
import { checkPlausibility, type PlausibilityConfig, type PlausibilityFailureReason } from './validation';

/**
 * Ingestion d'une position chauffeur (L3-02) : `position.update` (C-02) n'est traité que pour
 * une connexion chauffeur -- **l'identité vient du contexte de connexion, jamais du message**
 * (invariant posé par L3-01, critère d'acceptation 3) : ce message ne porte d'ailleurs aucun
 * identifiant de chauffeur dans sa charge utile.
 *
 * Une position rejetée est comptée (métrique en mémoire, critère d'acceptation 5) et ignorée,
 * sans fermer la connexion (critère d'acceptation 3) : les rejets sont normaux en zone dense.
 */

export type IngestOutcome =
  | { accepted: true }
  | { accepted: false; reason: PlausibilityFailureReason | 'not_a_driver' };

interface IngestMetricsSnapshot {
  accepted: number;
  rejected: number;
  rejectedByReason: Record<string, number>;
}

/** Compteurs en mémoire (critère d'acceptation 5) -- pas de dépendance de métriques nouvelle
 * (Prometheus, etc.) pour ce lot ; un futur endpoint /metrics peut les lire directement. */
class IngestMetrics {
  private accepted = 0;
  private rejected = 0;
  private readonly rejectedByReason = new Map<string, number>();

  recordAccepted(): void {
    this.accepted += 1;
  }

  recordRejected(reason: string): void {
    this.rejected += 1;
    this.rejectedByReason.set(reason, (this.rejectedByReason.get(reason) ?? 0) + 1);
  }

  snapshot(): IngestMetricsSnapshot {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      rejectedByReason: Object.fromEntries(this.rejectedByReason),
    };
  }

  reset(): void {
    this.accepted = 0;
    this.rejected = 0;
    this.rejectedByReason.clear();
  }
}

export const ingestMetrics = new IngestMetrics();

export function plausibilityConfigFrom(config: Config): PlausibilityConfig {
  return {
    bounds: {
      minLatitude: config.OPERATIONAL_BOUNDS_MIN_LAT,
      maxLatitude: config.OPERATIONAL_BOUNDS_MAX_LAT,
      minLongitude: config.OPERATIONAL_BOUNDS_MIN_LNG,
      maxLongitude: config.OPERATIONAL_BOUNDS_MAX_LNG,
    },
    maxAccuracyMeters: config.POSITION_MAX_ACCURACY_METERS,
    maxTimestampFutureMs: config.POSITION_MAX_TIMESTAMP_FUTURE_MS,
    maxTimestampAgeMs: config.POSITION_MAX_TIMESTAMP_AGE_MS,
    maxImpliedSpeedMetersPerSecond: config.POSITION_MAX_IMPLIED_SPEED_MPS,
  };
}

export async function ingestPosition(
  redis: Redis,
  context: ConnectionContext,
  message: realtime.PositionUpdateMessage,
  plausibility: PlausibilityConfig,
  ttlSeconds: number,
  nowMs: number = Date.now()
): Promise<IngestOutcome> {
  if (context.role !== 'driver' || !context.driverId) {
    // Un client n'émet jamais position.update (émetteur unique, C-02) -- défensif : rejeté sans
    // fermer la connexion, pas une exception, pour rester cohérent avec le traitement des autres
    // rejets de ce module.
    ingestMetrics.recordRejected('not_a_driver');
    return { accepted: false, reason: 'not_a_driver' };
  }

  const previousStored = await getPosition(redis, context.driverId);
  const sample = {
    latitude: message.payload.latitude,
    longitude: message.payload.longitude,
    accuracyMeters: message.payload.accuracyMeters,
    capturedAtMs: Date.parse(message.emittedAt),
  };

  const result = checkPlausibility(
    sample,
    previousStored
      ? {
          latitude: previousStored.latitude,
          longitude: previousStored.longitude,
          capturedAtMs: previousStored.capturedAtMs,
        }
      : null,
    plausibility,
    nowMs
  );

  if (!result.ok) {
    ingestMetrics.recordRejected(result.reason);
    return { accepted: false, reason: result.reason };
  }

  await storePosition(
    redis,
    context.driverId,
    {
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyMeters: sample.accuracyMeters,
      speedMetersPerSecond: message.payload.speedMetersPerSecond,
      headingDegrees: message.payload.headingDegrees,
      capturedAtMs: sample.capturedAtMs,
    },
    ttlSeconds
  );

  // Rejoint L3-04 : un chauffeur marqué en ligne (availability.set) mais sans position connue
  // n'a rien à mettre dans le géo-index tant qu'aucune position valide n'est arrivée -- c'est
  // ici, à la première acceptée, qu'il y entre réellement (L3-03).
  //
  // La décision d'éligibilité (en ligne, non réservé, non engagé -- D26) est entièrement dans le
  // script Lua : plus aucun `if` ici entre la lecture de l'état et l'écriture dans le pool. C'est
  // exactement l'inverse de ce qui a cassé l'invariant une première fois (amoa/questions/
  // REPONSES-2026-08-16-J7.md §2) -- un chauffeur réservé ou engagé qui émet une position ne
  // revient donc jamais dans le pool, quelle que soit la fréquence de ses positions (L3-06R,
  // critères 3 bis et 3 ter).
  await addEligibleToPool(redis, context.driverId, sample.latitude, sample.longitude);

  ingestMetrics.recordAccepted();
  return { accepted: true };
}
