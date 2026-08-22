import type Redis from 'ioredis';
import { http } from '@babana/contracts';
import type { Config } from '../config';
import { projectNearbyDrivers } from './projection';

/**
 * Élargissement du rayon (L3-08). Déclenchement, au sens de la spécification : le rayon demandé
 * (déjà plafonné par l'appelant, `nearby/handler.ts`) ne laisse plus aucun candidat une fois les
 * refusants de cette course exclus.
 *
 * **N'élargit jamais un abonnement de simple découverte, sans refusant à exclure** -- choix
 * d'implémentation tranché en écrivant cette tâche, consigné dans `amoa/questions/L3-08.md` :
 * `NEARBY_MAX_RADIUS_METERS` est un garde-fou anti-balayage (C2b, L3-05 critère 1), pas une
 * simple valeur par défaut -- un abonnement `HomeScreen` sans exclusion qui déclencherait
 * l'élargissement dès que la zone est clairsemée romprait cette garantie : un client obtiendrait
 * un rayon plus large que celui configuré simplement en se trouvant là où personne ne roule.
 * L'ensemble d'exclusion vide est donc le signal qui distingue une découverte libre (jamais
 * élargie) d'une resélection après refus (élargie si besoin) -- seule la seconde porte jamais des
 * identifiants exclus.
 *
 * **Ne réintroduit jamais d'attribution automatique (D11).** Cette fonction ne fait que reculer
 * la ligne à partir de laquelle `nearby/handler.ts` construit la liste des 5 -- le client choisit
 * toujours, il ne reçoit jamais qu'un candidat unique désigné pour lui.
 */
export type ExpandOutcome =
  | { drivers: http.NearbyDriver[] }
  // Nommé d'après le code d'erreur partagé (C-01/C-02, packages/contracts/src/errors.ts) --
  // NO_DRIVER_AVAILABLE n'est émis par aucun endpoint HTTP, seulement par ce chemin (C-01,
  // catalogue des erreurs). `nearby/handler.ts` traduit ce résultat en `nearby.drivers` avec une
  // liste vide : pas un message distinct, le client (L6-08) traite déjà ce cas comme
  // NO_DRIVER_AVAILABLE.
  | { noDriverAvailable: true };

/**
 * Paliers essayés, du rayon demandé jusqu'au plafond d'élargissement inclus -- jamais au-delà
 * (critère 2 : « le rayon s'élargit par paliers jusqu'au maximum »). Le premier palier est le
 * rayon déjà demandé : un ensemble d'exclusion vide qui échoue au premier palier est exactement
 * le cas « aucun chauffeur disponible dans le rayon initial » de la spécification.
 */
function radiusSteps(config: Config, requestedRadiusMeters: number): number[] {
  const steps: number[] = [requestedRadiusMeters];
  let radius = requestedRadiusMeters;
  while (radius < config.NEARBY_EXPAND_MAX_RADIUS_METERS) {
    radius = Math.min(radius + config.NEARBY_EXPAND_RADIUS_STEP_METERS, config.NEARBY_EXPAND_MAX_RADIUS_METERS);
    steps.push(radius);
  }
  return steps;
}

interface ExpansionBucketCounts {
  expansions: number;
  failures: number;
}

interface ExpansionMetricsSnapshot {
  expansions: number;
  failures: number;
  byBucket: Record<string, ExpansionBucketCounts>;
}

/**
 * Compteurs en mémoire (critère d'acceptation 4), même patron que `tracking/ingest.ts`
 * (`IngestMetrics`) -- pas de dépendance de métriques nouvelle pour ce lot.
 *
 * **« Zone »** : le pilote ne connaît qu'une seule `babana.zone` (`babana_zone_default.xml`,
 * session du 11 août) et ce service n'a aucun canal pour en lire le découpage -- pas de client
 * PostgreSQL (invariant 1), et L3-15/L3-16 ne couvrent que des paramètres et des profils, pas une
 * résolution point -> zone. En attendant qu'un tel canal existe, la zone est approchée par une
 * maille grossière de coordonnées (~5 km) : assez fin pour distinguer des quartiers de Douala,
 * assez grossier pour rester une maille de repérage, jamais une position individuelle. **Tranche
 * horaire** : heure UTC, faute d'un fuseau configuré ailleurs dans ce service -- choix
 * d'implémentation non spécifié, à revoir si L9 a besoin d'heure locale de Douala (UTC+1).
 */
class ExpansionMetrics {
  private expansions = 0;
  private failures = 0;
  private readonly byBucket = new Map<string, ExpansionBucketCounts>();

  private bucket(key: string): ExpansionBucketCounts {
    let counts = this.byBucket.get(key);
    if (!counts) {
      counts = { expansions: 0, failures: 0 };
      this.byBucket.set(key, counts);
    }
    return counts;
  }

  recordExpansion(bucketKey: string): void {
    this.expansions += 1;
    this.bucket(bucketKey).expansions += 1;
  }

  recordFailure(bucketKey: string): void {
    this.failures += 1;
    this.bucket(bucketKey).failures += 1;
  }

  snapshot(): ExpansionMetricsSnapshot {
    return {
      expansions: this.expansions,
      failures: this.failures,
      byBucket: Object.fromEntries(this.byBucket),
    };
  }

  reset(): void {
    this.expansions = 0;
    this.failures = 0;
    this.byBucket.clear();
  }
}

export const expansionMetrics = new ExpansionMetrics();

const ZONE_GRID_DEGREES = 0.05; // ~5 km à la latitude de Douala.

function bucketKeyFor(origin: { latitude: number; longitude: number }, nowMs: number): string {
  const zoneLat = Math.round(origin.latitude / ZONE_GRID_DEGREES) * ZONE_GRID_DEGREES;
  const zoneLng = Math.round(origin.longitude / ZONE_GRID_DEGREES) * ZONE_GRID_DEGREES;
  const hour = new Date(nowMs).getUTCHours();
  return `${zoneLat.toFixed(2)},${zoneLng.toFixed(2)}@${hour}h`;
}

/**
 * Cherche jusqu'à `limit` chauffeurs, excluant ceux qui ont déjà refusé cette course, en
 * élargissant le rayon palier par palier jusqu'à en trouver au moins un ou épuiser le plafond
 * (critère 3). Sur-échantillonne à chaque palier de la taille de l'exclusion : sans cette marge,
 * un candidat exclu réduirait silencieusement le compte rendu sous `limit` alors qu'un chauffeur
 * de plus existait au même rayon.
 */
export async function findNearbyWithExpansion(
  config: Config,
  redis: Redis,
  origin: { latitude: number; longitude: number },
  requestedRadiusMeters: number,
  excludeDriverIds: readonly string[],
  limit: number,
  nowMs: number = Date.now()
): Promise<ExpandOutcome> {
  const excluded = new Set(excludeDriverIds);
  if (excluded.size === 0) {
    // Découverte libre : jamais élargie (voir le commentaire de tête). Ni comptée ni journalisée
    // dans les métriques d'élargissement -- aucune tentative d'élargissement n'a eu lieu.
    const candidates = await projectNearbyDrivers(config, redis, origin, requestedRadiusMeters, limit);
    return candidates.length > 0 ? { drivers: candidates } : { noDriverAvailable: true };
  }
  const bucketKey = bucketKeyFor(origin, nowMs);
  let neededExpansion = false;
  for (const radiusMeters of radiusSteps(config, requestedRadiusMeters)) {
    const candidates = await projectNearbyDrivers(config, redis, origin, radiusMeters, limit + excluded.size);
    const filtered = candidates.filter((driver) => !excluded.has(driver.driverId)).slice(0, limit);
    if (filtered.length > 0) {
      // Le palier de départ a échoué au moins une fois avant celui-ci : c'est un élargissement
      // réel, à compter (critère 4). Réussir dès le premier palier n'en est pas un.
      if (neededExpansion) expansionMetrics.recordExpansion(bucketKey);
      return { drivers: filtered };
    }
    neededExpansion = true;
  }
  expansionMetrics.recordExpansion(bucketKey);
  expansionMetrics.recordFailure(bucketKey);
  return { noDriverAvailable: true };
}
