/**
 * Politique de reconnexion (L6-04, critère 1 ; L3-11) : temporisation croissante **et gigue
 * aléatoire** -- sans la gigue, mille chauffeurs se reconnectent en même temps après une coupure
 * d'antenne et achèvent le service temps réel (spécification L3-11, presque mot pour mot).
 */
export interface ReconnectPolicyConfig {
  /** Délai avant la première reconnexion, en ms. Défaut 1000. */
  baseDelayMs?: number;
  /** Plafond du délai, avant application de la gigue. Défaut 30000 (30 s). */
  maxDelayMs?: number;
  /** Amplitude de la gigue, en proportion du délai (0.3 = ±30 %). Défaut 0.3. */
  jitterRatio?: number;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.3;

/**
 * `attempt` commence à 0 (première tentative de reconnexion). Croissance exponentielle plafonnée
 * à `maxDelayMs`, puis gigue appliquée en dernier -- plafonner avant la gigue borne le pire cas à
 * `maxDelayMs * (1 + jitterRatio)`, jamais un délai qui explose au-delà du plafond voulu.
 */
export function computeReconnectDelayMs(attempt: number, config: ReconnectPolicyConfig = {}): number {
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO;

  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const jitterSpan = exponential * jitterRatio;
  const jitter = jitterSpan * (Math.random() * 2 - 1); // dans [-jitterSpan, +jitterSpan]
  return Math.max(0, Math.round(exponential + jitter));
}
