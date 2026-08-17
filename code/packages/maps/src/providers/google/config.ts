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

export function configureGoogleMapsProvider(config: { apiKey: string }): void {
  apiKey = config.apiKey;
}

export function getGoogleMapsApiKey(): string {
  if (!apiKey) {
    throw new Error(
      "@babana/maps: configureMapsProvider({ apiKey }) doit être appelé au démarrage de l'app " +
        'avant tout appel à searchPlace/reverseGeocode (invariant 5 -- aucune clé codée en dur).'
    );
  }
  return apiKey;
}

/** Réservé aux tests : remet le module dans son état initial entre deux cas. */
export function _resetGoogleMapsApiKeyForTests(): void {
  apiKey = undefined;
}
