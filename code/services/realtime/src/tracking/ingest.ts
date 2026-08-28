import type Redis from 'ioredis';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { getPosition, storePosition } from '../redis/positions';
import { addEligibleToPool } from '../redis/pool-eligibility';
import { checkPlausibility, type PlausibilityConfig, type PlausibilityFailureReason } from './validation';
import { accumulatePosition, type AccumulationConfig } from './accumulator';

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

export function accumulationConfigFrom(config: Config): AccumulationConfig {
  return {
    minSegmentMeters: config.ACCUMULATION_MIN_SEGMENT_METERS,
    simplifyToleranceMeters: config.ACCUMULATION_SIMPLIFY_TOLERANCE_METERS,
    maxTrackPoints: config.ACCUMULATION_MAX_TRACK_POINTS,
    ttlSeconds: config.ACCUMULATION_TTL_SECONDS,
  };
}

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

interface RawSample {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  capturedAtMs: number;
}

/**
 * Un seul relevé, déjà résolu en `RawSample` -- coeur inchangé de ce qui existait avant L6-05
 * (agrégation) : la validation de plausibilité compare toujours contre la DERNIÈRE position
 * stockée en Redis, jamais contre un point du même lot qui ne serait pas encore écrit. `ingestPosition`
 * ci-dessous appelle cette fonction séquentiellement, un lot de N points coûtant donc N allers-
 * retours Redis -- même coût qu'avant si l'appelant n'envoie qu'un point à la fois
 * (`precedingSamples` vide, cas par défaut).
 */
async function ingestOne(
  redis: Redis,
  driverId: string,
  sample: RawSample,
  plausibility: PlausibilityConfig,
  ttlSeconds: number,
  nowMs: number,
  accumulation?: AccumulationConfig
): Promise<IngestOutcome> {
  const previousStored = await getPosition(redis, driverId);

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
    driverId,
    {
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyMeters: sample.accuracyMeters,
      speedMetersPerSecond: sample.speedMetersPerSecond,
      headingDegrees: sample.headingDegrees,
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
  await addEligibleToPool(redis, driverId, sample.latitude, sample.longitude);

  // L3-10 : accumule distance / durée / tracé si une course est en cours pour ce chauffeur
  // (l'accumulation elle-même vérifie qu'elle est active -- rien ici ne le sait). N'alimente
  // l'accumulation qu'avec des positions DÉJÀ acceptées : une position rejetée n'arrive jamais
  // ici (critère 2). Filet : une panne d'accumulation ne doit jamais faire tomber une position
  // ni fermer la connexion (même politique que le reste du service).
  if (accumulation) {
    try {
      await accumulatePosition(redis, driverId, { latitude: sample.latitude, longitude: sample.longitude }, accumulation);
    } catch {
      // L'accumulation sert au contrôle et à la calibration, jamais au tarif -- un tick manqué
      // n'est pas un incident.
    }
  }

  ingestMetrics.recordAccepted();
  return { accepted: true };
}

/**
 * `message.payload` porte le point le plus récent, plus -- optionnellement -- les relevés
 * accumulés avant lui (`precedingSamples`, L6-05, agrégation avant envoi côté app Chauffeur : voir
 * `apps/driver/src/location/tracker.ts`). Traités dans l'ordre chronologique, chacun contre la
 * validation de plausibilité (L3-02) comme s'il était arrivé seul -- un point du lot rejeté
 * n'empêche pas les suivants d'être tentés (même politique que pour un point isolé : le réseau
 * mobile est intermittent, un point aberrant au milieu d'un lot n'est pas une faute qui doit en
 * invalider d'autres).
 *
 * Renvoie l'issue du point le plus récent (dernier traité) -- c'est celui qui compte pour
 * l'appelant historique d'avant L6-05 (`ws/dispatch.ts` ignore de toute façon la valeur de
 * retour ; seuls les tests l'inspectent).
 */
export async function ingestPosition(
  redis: Redis,
  context: ConnectionContext,
  message: realtime.PositionUpdateMessage,
  plausibility: PlausibilityConfig,
  ttlSeconds: number,
  nowMs: number = Date.now(),
  // L3-10 : optionnel -- seul `ws/dispatch.ts` le fournit en production. Absent, l'accumulation
  // n'est simplement pas alimentée (les tests d'ingestion qui ne s'y intéressent pas le laissent
  // vide).
  accumulation?: AccumulationConfig
): Promise<IngestOutcome> {
  if (context.role !== 'driver' || !context.driverId) {
    // Un client n'émet jamais position.update (émetteur unique, C-02) -- défensif : rejeté sans
    // fermer la connexion, pas une exception, pour rester cohérent avec le traitement des autres
    // rejets de ce module.
    ingestMetrics.recordRejected('not_a_driver');
    return { accepted: false, reason: 'not_a_driver' };
  }

  const preceding: RawSample[] = message.payload.precedingSamples.map((sample) => ({
    latitude: sample.latitude,
    longitude: sample.longitude,
    accuracyMeters: sample.accuracyMeters,
    speedMetersPerSecond: sample.speedMetersPerSecond,
    headingDegrees: sample.headingDegrees,
    capturedAtMs: Date.parse(sample.capturedAt),
  }));
  const latest: RawSample = {
    latitude: message.payload.latitude,
    longitude: message.payload.longitude,
    accuracyMeters: message.payload.accuracyMeters,
    speedMetersPerSecond: message.payload.speedMetersPerSecond,
    headingDegrees: message.payload.headingDegrees,
    capturedAtMs: Date.parse(message.emittedAt),
  };

  let outcome: IngestOutcome = { accepted: false, reason: 'not_a_driver' };
  for (const sample of [...preceding, latest]) {
    // eslint-disable-next-line no-await-in-loop -- séquentiel par nécessité : chaque point doit
    // être validé contre la dernière position RÉELLEMENT stockée, y compris celle que le point
    // précédent du même lot vient d'écrire.
    outcome = await ingestOne(redis, context.driverId, sample, plausibility, ttlSeconds, nowMs, accumulation);
  }
  return outcome;
}
