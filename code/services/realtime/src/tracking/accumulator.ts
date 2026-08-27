import type Redis from 'ioredis';
import { haversineDistanceMeters } from './validation';

/**
 * Accumulation distance / durée / tracé d'une course (L3-10).
 *
 * **Invariant 1, et c'est la tâche où on serait tenté de le perdre** : rien de ce qui est
 * accumulé ici n'écrit dans Odoo. Distance, durée et tracé vivent dans Redis pendant la course et
 * ne rejoignent Odoo qu'au moment de la fin de course -- une écriture, à une décision humaine
 * (le chauffeur qui appuie sur « Terminer »). Ces valeurs servent au contrôle et à la calibration
 * (L10-03), **jamais au tarif** : D15 retire le terme temps, la distance facturée est celle de
 * l'itinéraire de référence (L2-05, L4-04).
 *
 * **Restart-safe (L3-14)** : tout l'état vit dans un seul HASH Redis, aucun état en mémoire du
 * processus. Le service temps réel peut tomber en pleine course : au redémarrage, les positions
 * reprennent, `accumulatePosition` relit le HASH et continue là où il en était. Un TTL de sécurité
 * (`ACCUMULATION_TTL_SECONDS`, rafraîchi à chaque position) fait expirer une accumulation
 * orpheline -- fin de course dont la notification s'est perdue, service tué entre la fin et
 * `clear_engagement`.
 *
 * **Un seul écrivain par nature** : les positions d'un chauffeur arrivent sur une seule connexion
 * WebSocket, traitées séquentiellement (`ws/dispatch.ts`). Pas de section critique à protéger
 * comme le pool (D26) -- ce module n'est pas dans la liste des modules sensibles à couverture
 * exhaustive (moteur de cotation, machine à états, compte courant, réservation atomique). Une
 * brève double connexion pendant une reconnexion peut fausser la distance de quelques mètres le
 * temps d'un tick ; c'est une donnée de calibration, pas un franc.
 */

export interface AccumulationConfig {
  /** En dessous, un déplacement depuis le dernier point retenu est du bruit GPS à l'arrêt : ni
   * accumulé, ni avancé (filtre par distance radiale -- une moto qui rampe dans les embouteillages
   * finit quand même par franchir ce seuil et accumule alors le saut entier). */
  minSegmentMeters: number;
  /** Tolérance de colinéarité : un point intermédiaire dont la distance perpendiculaire au
   * segment [avant-dernier, nouveau] est en dessous est redondant -- on le remplace plutôt que de
   * l'empiler. Garde les virages, jette les lignes droites (critère 3 : « conserve la forme »). */
  simplifyToleranceMeters: number;
  /** Plafond dur du nombre de sommets du tracé : au-delà, on ne fait plus que remplacer le dernier
   * point (la queue du tracé se grossit) plutôt que d'empiler des milliers de points. */
  maxTrackPoints: number;
  /** Filet de sécurité : une accumulation qui n'a pas reçu de position depuis ce délai expire. */
  ttlSeconds: number;
}

export interface RideMeasurement {
  distanceMeters: number;
  durationSeconds: number;
  /** Polyline encodée (algorithme Google, précision 5) du tracé simplifié. `''` si aucun point
   * n'a encore été retenu (course démarrée, aucune position exploitable reçue). */
  polyline: string;
  pointCount: number;
}

const ACCUMULATION_KEY_PREFIX = 'babana:ride:accumulation:';

export function accumulationKey(driverId: string): string {
  return `${ACCUMULATION_KEY_PREFIX}${driverId}`;
}

type Point = [number, number]; // [latitude, longitude]

/**
 * Démarre l'accumulation à `ride.start` (L3-10 : « Depuis `ride.start`, accumuler dans Redis »).
 * Appelé par `http/internal.ts::handleRideStarted`, au commit de `action_start` côté Odoo (D32).
 * Écrase une accumulation résiduelle du même chauffeur -- un `ride.start` est une décision
 * fraîche.
 */
export async function startAccumulation(
  redis: Redis,
  driverId: string,
  ttlSeconds: number,
  nowMs: number = Date.now()
): Promise<void> {
  const key = accumulationKey(driverId);
  const pipeline = redis.multi();
  pipeline.del(key);
  pipeline.hset(key, { startedAtMs: nowMs, distanceMeters: 0, track: '[]' });
  pipeline.expire(key, ttlSeconds);
  await pipeline.exec();
}

/**
 * Intègre une position **déjà acceptée** par la validation de plausibilité (L3-02) : les positions
 * rejetées n'arrivent jamais ici (critère 2), parce que `ingest.ts` n'appelle cette fonction
 * qu'après un `checkPlausibility` réussi. Sans accumulation active pour ce chauffeur : ne fait
 * rien (la course n'a pas démarré, ou est déjà terminée).
 */
export async function accumulatePosition(
  redis: Redis,
  driverId: string,
  sample: { latitude: number; longitude: number },
  config: AccumulationConfig
): Promise<void> {
  const key = accumulationKey(driverId);
  const raw = await redis.hgetall(key);
  if (!raw || raw.startedAtMs === undefined) return;

  // Filet de sécurité : chaque position repousse l'expiration. Une course active ne disparaît
  // jamais faute de TTL ; une course orpheline finit par le faire.
  await redis.expire(key, config.ttlSeconds);

  const track: Point[] = raw.track ? (JSON.parse(raw.track) as Point[]) : [];
  const current: Point = [sample.latitude, sample.longitude];

  // Premier point : rien à mesurer encore, on pose l'origine du tracé.
  if (raw.lastLat === undefined || raw.lastLng === undefined) {
    track.push(current);
    await redis.hset(key, {
      lastLat: current[0],
      lastLng: current[1],
      track: JSON.stringify(track),
    });
    return;
  }

  const lastKept: Point = [Number(raw.lastLat), Number(raw.lastLng)];
  const segmentMeters = haversineDistanceMeters(
    { latitude: lastKept[0], longitude: lastKept[1] },
    { latitude: current[0], longitude: current[1] }
  );

  // Filtre par distance radiale : sous le seuil, on n'avance pas le dernier point retenu. Le bruit
  // GPS à l'arrêt tourne autour du même point sans jamais s'en éloigner assez -> distance = 0
  // (critère 1). Un déplacement lent finit par franchir le seuil et accumule alors le saut entier.
  if (segmentMeters < config.minSegmentMeters) return;

  const distanceMeters = Number(raw.distanceMeters ?? 0) + segmentMeters;

  simplifyAppend(track, current, config);

  await redis.hset(key, {
    distanceMeters,
    lastLat: current[0],
    lastLng: current[1],
    track: JSON.stringify(track),
  });
}

/**
 * Simplification au fil de l'eau (critère 3) : fenêtre glissante de trois points. Si l'avant-
 * dernier sommet retenu est quasi colinéaire avec le segment formé par celui d'avant et le
 * nouveau point, il était un point de ligne droite redondant -> on le remplace. Sinon, c'est un
 * virage -> on empile. Un tracé rectiligne se réduit à ses deux extrémités ; une forme en L garde
 * son coin.
 */
function simplifyAppend(track: Point[], next: Point, config: AccumulationConfig): void {
  if (track.length >= 2) {
    const before = track[track.length - 2]!;
    const mid = track[track.length - 1]!;
    if (perpendicularDistanceMeters(mid, before, next) < config.simplifyToleranceMeters) {
      track[track.length - 1] = next;
      return;
    }
  }
  if (track.length >= config.maxTrackPoints) {
    track[track.length - 1] = next;
    return;
  }
  track.push(next);
}

/** Lit l'accumulation courante (L3-10, fin de course) : `null` si aucune n'est active. La durée
 * est le temps d'horloge écoulé depuis `ride.start`, pas la somme des intervalles entre positions
 * (une coupure réseau ne raccourcit pas la course). */
export async function getAccumulation(
  redis: Redis,
  driverId: string,
  nowMs: number = Date.now()
): Promise<RideMeasurement | null> {
  const raw = await redis.hgetall(accumulationKey(driverId));
  if (!raw || raw.startedAtMs === undefined) return null;

  const track: Point[] = raw.track ? (JSON.parse(raw.track) as Point[]) : [];
  const startedAtMs = Number(raw.startedAtMs);

  return {
    distanceMeters: Math.round(Number(raw.distanceMeters ?? 0)),
    durationSeconds: Math.max(0, Math.round((nowMs - startedAtMs) / 1000)),
    polyline: encodePolyline(track),
    pointCount: track.length,
  };
}

/** Efface l'accumulation à la fin de course ou à l'annulation (L3-10) : appelé par
 * `http/internal.ts::handleClearEngagement`, qui reçoit le même signal `/internal/engagement/clear`
 * dans les deux cas. Idempotent. */
export async function endAccumulation(redis: Redis, driverId: string): Promise<void> {
  await redis.del(accumulationKey(driverId));
}

// --- Géométrie locale (échelle de Douala : projection équirectangulaire, suffisante) -----------

const METERS_PER_DEGREE_LAT = 111_320;

function toLocalMeters(point: Point, origin: Point): { x: number; y: number } {
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return {
    x: (point[1] - origin[1]) * metersPerDegreeLng,
    y: (point[0] - origin[0]) * METERS_PER_DEGREE_LAT,
  };
}

/** Distance perpendiculaire de `point` au segment [`segStart`, `segEnd`], en mètres, dans le plan
 * local -- pas une distance à un point d'extrémité : un point qui « dépasse » le segment est
 * projeté sur son extrémité. */
function perpendicularDistanceMeters(point: Point, segStart: Point, segEnd: Point): number {
  const p = toLocalMeters(point, segStart);
  const b = toLocalMeters(segEnd, segStart);
  const lengthSquared = b.x * b.x + b.y * b.y;
  if (lengthSquared === 0) return Math.hypot(p.x, p.y);
  let t = (p.x * b.x + p.y * b.y) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - t * b.x, p.y - t * b.y);
}

// --- Encodage polyline (algorithme Google, précision 5) ---------------------------------------

function encodeSignedNumber(value: number): string {
  let sgnNum = value << 1;
  if (value < 0) sgnNum = ~sgnNum;
  let result = '';
  while (sgnNum >= 0x20) {
    result += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  result += String.fromCharCode(sgnNum + 63);
  return result;
}

export function encodePolyline(points: Point[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += encodeSignedNumber(latE5 - lastLat);
    result += encodeSignedNumber(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return result;
}
