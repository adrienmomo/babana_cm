/**
 * Minuteurs de délai d'acceptation, un par chauffeur (L3-07, critère d'acceptation 6 : le délai
 * est lu depuis la configuration, jamais codé en dur -- voir `config.ts`,
 * `PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS`). Même forme que
 * `driver/availability.ts::DisconnectGraceTimers` : programmer un nouveau minuteur pour un
 * chauffeur annule silencieusement le précédent -- ne devrait de toute façon jamais arriver tant
 * qu'une proposition est active, un chauffeur réservé n'étant plus dans le pool, donc pas
 * re-proposable avant résolution de la proposition en cours (L3-06, D26).
 *
 * Le compte à rebours affiché côté chauffeur est indicatif ; ce minuteur, côté serveur, est seul
 * juge de l'expiration (amoa/specs/L3-temps-reel.md, L3-07).
 */
export class ProposalTimeoutTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(driverId: string, delaySeconds: number, onExpire: () => void): void {
    this.cancel(driverId);
    const timer = setTimeout(() => {
      this.timers.delete(driverId);
      onExpire();
    }, delaySeconds * 1000);
    // unref() : même raisonnement que les autres minuteurs du service (ws/connection.ts,
    // driver/availability.ts) -- ne doit jamais empêcher un arrêt propre du processus.
    timer.unref();
    this.timers.set(driverId, timer);
  }

  cancel(driverId: string): void {
    const timer = this.timers.get(driverId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(driverId);
    }
  }

  has(driverId: string): boolean {
    return this.timers.has(driverId);
  }
}
