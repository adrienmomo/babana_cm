/**
 * Adresse du service de routage (format OSRM : `{base}/route/v1/driving/{lon},{lat};{lon},{lat}`).
 * Injectée par l'app au démarrage (invariant 5 : jamais codée en dur ici), via
 * `configureMapsProvider({ routingUrl })`. Absente : aucun itinéraire n'est calculé (`fetchRoute`
 * renvoie `null`) -- ce n'est pas un repli vers un serveur public que personne n'a choisi (D43).
 */
let routingUrl: string | undefined;

export function setRoutingUrl(url: string | undefined): void {
  routingUrl = url ? url.replace(/\/+$/, '') : undefined;
}

export function getRoutingUrl(): string | undefined {
  return routingUrl;
}

/** Réservé aux tests. */
export function _resetRoutingUrlForTests(): void {
  routingUrl = undefined;
}
