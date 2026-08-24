import { computeReconnectDelayMs, type ReconnectPolicyConfig } from './reconnect';

/**
 * Surveillance de silence PAR ABONNEMENT (L3-20, D47 --
 * amoa/questions/L3-05-nearby-list-goes-silently-empty.md, amoa/questions/
 * REPONSES-2026-08-30.md §1). Un battement de cœur sur la connexion ne suffit pas : deux pannes
 * produisent le même silence apparent -- une connexion à moitié fermée (le cas courant sur un
 * réseau mobile, détectée côté transport par `services/realtime/src/ws/liveness.ts`) et un flux
 * mort sur une connexion vivante (la cause racine du 30 août : la connexion restait `connected`,
 * un battement de cœur aurait répondu normalement pendant que la diffusion périodique
 * elle-même s'était tue). Un flux périodique connaît sa propre cadence, donc il sait ce que son
 * silence signifie -- c'est ce que ce module encapsule, générique à n'importe quel flux
 * (`nearby.drivers` pour `HomeScreen`, `driver.position` pour `TrackingScreen`, même patron pour
 * l'app Chauffeur).
 *
 * **Le dire compte autant que se réabonner** (spécification) : `onStale`/`onRecovered` donnent à
 * l'écran de quoi afficher "position datée de N secondes" plutôt qu'un marqueur figé ou un
 * silence -- même principe que l'accusé de réception explicite de la limitation de débit
 * (nearby/handler.ts, doute L6-06 §3).
 *
 * **Le réabonnement ne doit jamais aggraver la limitation de débit** (spécification, la trappe
 * que ce mécanisme ouvre naturellement) : `computeReconnectDelayMs` (`./reconnect.ts`) est
 * réutilisé tel quel plutôt qu'une seconde politique de délai -- croissance exponentielle plus
 * gigue, déjà pensée pour éviter qu'un grand nombre de clients ne martèlent le serveur au même
 * instant (L3-11). Un seul réabonnement immédiat à la détection du silence, puis un délai
 * croissant tant que le flux ne reprend pas -- jamais une tentative à chaque vérification.
 */
export interface StreamLivenessConfig {
  /** Cadence attendue du flux, en ms (ex. la valeur par défaut connue côté app de
   * NEARBY_BROADCAST_INTERVAL_SECONDS/TRACKING_BROADCAST_INTERVAL_SECONDS -- PROVISOIRE au sens
   * de D21, comme NEARBY_SUBSCRIBE_RADIUS_METERS dans HomeScreen : aucun canal de configuration
   * Odoo -> app n'existe pour transmettre la vraie valeur serveur, L3-15 ne couvre que Odoo ->
   * temps réel). */
  expectedIntervalMs: number;
  /** Multiple de la cadence toléré avant de déclarer le flux silencieux (spécification : "un
   * multiple configurable de cette cadence"). Défaut 3 : assez de marge pour absorber la gigue
   * normale d'un réseau mobile sans fausse alerte, assez court pour rester utile. */
  missedTicksThreshold?: number;
  /** Le flux est resté silencieux au-delà du seuil -- `silentForMs` pour l'afficher ("position
   * datée de N secondes"). Appelé une seule fois par entrée en silence, pas à chaque
   * vérification. */
  onStale: (silentForMs: number) => void;
  /** Le flux a repris après avoir été silencieux. */
  onRecovered: () => void;
  /** Réémet l'abonnement (même message que celui déjà envoyé par l'écran à l'ouverture) -- sur
   * la connexion existante, pas une reconnexion : la cause racine du 30 août était un abonnement
   * mort sur une connexion par ailleurs vivante. */
  resubscribe: () => void;
  reconnectPolicy?: ReconnectPolicyConfig;
  /** Injectables pour les tests -- mêmes signatures que `./connection.ts`. */
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_MISSED_TICKS_THRESHOLD = 3;

export class StreamLivenessWatchdog {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private lastActivityAtMs: number;
  private stale = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private resubscribeAttempt = 0;
  // Voir attemptResubscribe() -- identifie la boucle de silence en cours, incrémenté par
  // clearStaleState() pour invalider silencieusement toute boucle antérieure encore en vol.
  private generation = 0;

  constructor(private readonly config: StreamLivenessConfig) {
    this.now = config.now ?? Date.now;
    this.wait = config.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.lastActivityAtMs = this.now();
  }

  /** À appeler après le premier abonnement (ou tout réabonnement explicite fait par l'écran
   * lui-même, ex. changement de position de départ) -- redémarre le compte depuis maintenant. */
  start(): void {
    this.lastActivityAtMs = this.now();
    this.clearStaleState();
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = setInterval(() => this.check(), this.config.expectedIntervalMs);
  }

  /** À appeler quand l'écran se désabonne (démontage, changement d'écran) -- plus aucune
   * vérification, plus aucun réabonnement automatique pour un flux que personne ne regarde plus. */
  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    this.clearStaleState();
  }

  /** À appeler à chaque message reçu du flux surveillé. */
  recordActivity(): void {
    this.lastActivityAtMs = this.now();
    const wasStale = this.stale;
    this.clearStaleState();
    if (wasStale) this.config.onRecovered();
  }

  /** Silence actuel, en ms -- pour un affichage qui se met à jour ("il y a Ns"), pas un instantané figé. */
  silentForMs(): number {
    return Math.max(0, this.now() - this.lastActivityAtMs);
  }

  private clearStaleState(): void {
    this.stale = false;
    this.resubscribeAttempt = 0;
    // Invalide toute boucle de réabonnement en cours (voir attemptResubscribe ci-dessous) : elle
    // se relit à son réveil, jamais annulée directement (`wait` est injectable pour les tests,
    // pas un vrai minuteur qu'on pourrait clearTimeout()).
    this.generation += 1;
  }

  private check(): void {
    const threshold = (this.config.missedTicksThreshold ?? DEFAULT_MISSED_TICKS_THRESHOLD) * this.config.expectedIntervalMs;
    if (this.silentForMs() < threshold || this.stale) return;
    this.stale = true;
    this.config.onStale(this.silentForMs());
    void this.attemptResubscribe(this.generation);
  }

  /**
   * `generation` identifie la boucle de silence qui a démarré cette tentative -- si
   * `recordActivity()`/`stop()`/`start()` a entre-temps fait avancer `this.generation` (silence
   * terminé, écran démonté, ou nouveau silence après une reprise), cette tentative se sait
   * périmée à son réveil et s'arrête d'elle-même plutôt que de continuer une boucle qui n'a plus
   * lieu d'être.
   */
  private async attemptResubscribe(generation: number): Promise<void> {
    this.config.resubscribe();
    const delay = computeReconnectDelayMs(this.resubscribeAttempt, this.config.reconnectPolicy);
    this.resubscribeAttempt += 1;
    await this.wait(delay);
    // Toujours silencieux, dans la même génération, malgré la tentative précédente -- réessaie,
    // avec un délai plus long à chaque fois (computeReconnectDelayMs) : c'est ce qui empêche le
    // réabonnement automatique de devenir lui-même le comportement qui martèle la limitation de
    // débit.
    if (this.stale && generation === this.generation) void this.attemptResubscribe(generation);
  }
}
