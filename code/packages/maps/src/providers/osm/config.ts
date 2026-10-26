/**
 * Fond de carte OpenStreetMap : adresse des tuiles raster (`https://.../{z}/{x}/{y}.png`, ou
 * `...{y}{r}.png` pour un fournisseur qui sert des tuiles @2x aux écrans denses) et crédit exigé par
 * sa licence. Injectés par l'app au démarrage (invariant 5 : jamais codés en dur ici), via
 * `configureMapsProvider`.
 *
 * `undefined` = pas de carte OSM : la carte reste celle de Google. Ce n'est volontairement pas un
 * repli vers `tile.openstreetmap.org` (D43) : ce serveur public interdit l'usage intensif et
 * identifie les clients ; la production pointe vers un fournisseur de tuiles dont les conditions
 * conviennent, jamais vers une adresse par défaut que personne n'a choisie.
 *
 * L'attribution suit la même règle (24 octobre) : elle dépend du fournisseur choisi, elle n'a donc
 * pas de texte par défaut -- un crédit OpenStreetMap figé aurait cité le mauvais fournisseur dès
 * qu'on en change, sans que rien ne le signale.
 */
export interface MapTiles {
  url: string;
  attribution: string;
}

let tiles: MapTiles | undefined;

export function setMapTiles(url: string | undefined, attribution: string | undefined): void {
  if (!url) {
    tiles = undefined;
    return;
  }
  if (!attribution) {
    throw new Error(
      '@babana/maps: BABANA_MAP_TILE_ATTRIBUTION est requise avec BABANA_MAP_TILE_URL -- le crédit ' +
        'exigé par le fournisseur de tuiles n\'a pas de valeur par défaut (D43).'
    );
  }
  tiles = { url, attribution };
}

export function getMapTiles(): MapTiles | undefined {
  return tiles;
}

/** Réservé aux tests. */
export function _resetMapTileUrlForTests(): void {
  tiles = undefined;
}
