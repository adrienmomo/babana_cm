/**
 * Remontée de métrique minimale, provisoire -- aucun collecteur ni endpoint de télémétrie
 * n'existe encore dans le dépôt (L6-17, `apps/driver/src/telemetry/`, hors de ce lot). Ce module
 * n'est qu'un point d'accroche unique, pour que L6-17 n'ait qu'un seul endroit à brancher sur un
 * vrai collecteur plutôt que de retrouver des `console.warn` épars dans chaque appelant --
 * critère d'acceptation 4 de L6-02 ("remontée d'une métrique") a besoin d'un point d'accroche
 * dès ce soir, pas d'un vrai tableau de bord.
 */
export function reportMetric(name: string, payload?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- seul collecteur existant ce soir, voir le commentaire ci-dessus.
  console.warn(`[metric] ${name}`, payload ?? {});
}
