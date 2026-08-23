/**
 * Clé Google Maps pour les appels REST (Places, Geocoding) émis directement par ce fournisseur.
 * Jamais codée en dur (invariant 5) : injectée explicitement par l'app au démarrage, pas lue
 * depuis `process.env` ici -- ce paquet est prébuilt en `dist/` (pas de passe Babel qui
 * inlinerait une variable d'environnement, contrairement au config.ts de chaque app, L0-03). La clé du
 * SDK natif de carte (rendu de `<MapView>` lui-même) est un réglage de build natif distinct
 * (`GOOGLE_MAPS_API_KEY`, AndroidManifest.xml / Info.plist), hors du périmètre de L6-01 --
 * prérequis déjà suivi (`05-prerequis-et-simulation.md` §5, avant L6-06).
 */
let apiKey: string | undefined;

/**
 * Adresse de la recherche de lieu (D19, `amoa/questions/C-01R.md` §2). Une seule variable
 * d'environnement fait pointer ce module vers `mock-maps` en développement ou vers l'API Google
 * réelle en production -- ce fichier ne contient aucune branche conditionnelle sur
 * l'environnement, seul `searchUrl` change.
 *
 * `undefined` ne retombe plus sur l'adresse Google réelle (D43,
 * `amoa/questions/REPONSES-2026-08-28.md` §4) : ce repli faisait exactement ce que le code fait
 * quand tout va bien, avec un destinataire différent -- invisible sans lire le trafic réseau. Une
 * adresse non configurée doit échouer à l'appel, bruyamment (`getSearchUrl` ci-dessous) ; la
 * production configure explicitement `PLACES_TEXT_SEARCH_URL` (places.ts) via `searchUrl`, elle
 * ne la reçoit jamais par défaut.
 */
let searchUrl: string | undefined;

export function configureGoogleMapsProvider(config: { apiKey: string; searchUrl?: string }): void {
  apiKey = config.apiKey;
  searchUrl = config.searchUrl;
}

/**
 * `apiKey` distingue « jamais configuré » (`undefined`, invariant 5 : personne n'a appelé
 * `configureMapsProvider` au démarrage) de « configuré à vide » (`''`, cas réel du développement
 * avec `mock-maps` -- voir bootstrap.ts -- qui n'a besoin d'aucune clé). Seul le premier cas est
 * une faute de câblage ; le second est une configuration valide dont searchPlace se sert pour
 * omettre le paramètre `key` de la requête (places.ts).
 */
export function getGoogleMapsApiKey(): string {
  if (apiKey === undefined) {
    throw new Error(
      "@babana/maps: configureMapsProvider({ apiKey }) doit être appelé au démarrage de l'app " +
        'avant tout appel à searchPlace/reverseGeocode (invariant 5 -- aucune clé codée en dur).'
    );
  }
  return apiKey;
}

/**
 * Lève plutôt que de retomber sur une adresse par défaut (D43) -- même principe que
 * `getGoogleMapsApiKey` ci-dessus, appliqué à l'adresse plutôt qu'à la clé : un fournisseur
 * externe non configuré doit échouer bruyamment à l'appel, jamais silencieusement appeler la
 * vraie API avec un destinataire différent de celui attendu.
 */
export function getSearchUrl(): string {
  if (searchUrl === undefined) {
    throw new Error(
      "@babana/maps: configureMapsProvider({ searchUrl }) doit être appelé au démarrage de l'app " +
        "avant tout appel à searchPlace -- aucune adresse de fournisseur externe ne retombe " +
        'silencieusement sur une valeur par défaut (invariant 5, D43).'
    );
  }
  return searchUrl;
}

/** Réservé aux tests : remet le module dans son état initial entre deux cas. */
export function _resetGoogleMapsApiKeyForTests(): void {
  apiKey = undefined;
  searchUrl = undefined;
}
