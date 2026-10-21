/**
 * Adresse des tuiles raster de la carte OpenStreetMap (`https://.../{z}/{x}/{y}.png`). Injectée par
 * l'app au démarrage (invariant 5 : jamais codée en dur ici), via `configureMapsProvider`.
 *
 * `undefined` = pas de carte OSM : la carte reste celle de Google. Ce n'est volontairement pas un
 * repli vers `tile.openstreetmap.org` (D43) : ce serveur public interdit l'usage intensif et
 * identifie les clients ; la production pointe vers un fournisseur de tuiles dont les conditions
 * conviennent, jamais vers une adresse par défaut que personne n'a choisie.
 */
let tileUrl: string | undefined;

export function setMapTileUrl(url: string | undefined): void {
  tileUrl = url || undefined;
}

export function getMapTileUrl(): string | undefined {
  return tileUrl;
}

/** Réservé aux tests. */
export function _resetMapTileUrlForTests(): void {
  tileUrl = undefined;
}
