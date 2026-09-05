/**
 * Chargement paresseux du script Google Maps JavaScript -- une seule fois par onglet, quel que
 * soit le nombre de `<MapView>` montés (HomeScreen, TrackingScreen, RideSummaryScreen). Même
 * discipline que `packages/api-client/src/auth/googleSignIn.web.ts` (chargement de script GIS) :
 * un `<script>` avec un callback global, jamais un polling sur `window.google`.
 *
 * La clé utilisée est celle déjà posée par `configureMapsProvider({ apiKey, searchUrl })`
 * (`providers/google/config.ts`, `getGoogleMapsApiKey`) -- aucune configuration distincte pour ce
 * fournisseur : c'est la même clé Google Cloud Console qui active à la fois les API REST
 * (Places, Geocoding) et Maps JavaScript. Une clé vide (développement, aucune carte réelle
 * n'étant nécessaire pour les autres écrans de démonstration -- `mock-maps` fait le reste) charge
 * quand même le script, sans paramètre `key` : Google sert alors une carte fonctionnelle avec un
 * filigrane « for development purposes only », jamais une page blanche.
 */
let mapsLoadPromise: Promise<void> | undefined;

const GOOGLE_MAPS_SCRIPT_ORIGIN = 'https://maps.googleapis.com/maps/api/js';
const READY_CALLBACK_NAME = '__babanaGoogleMapsReady';

export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error("@babana/maps: MapView (web) rendu hors d'un navigateur."));
  }
  if (window.google?.maps) return Promise.resolve();
  if (!mapsLoadPromise) {
    mapsLoadPromise = new Promise((resolve, reject) => {
      const globalScope = window as unknown as Record<string, (() => void) | undefined>;
      globalScope[READY_CALLBACK_NAME] = () => {
        delete globalScope[READY_CALLBACK_NAME];
        resolve();
      };

      const params = new URLSearchParams({ callback: READY_CALLBACK_NAME });
      if (apiKey) params.set('key', apiKey);

      const script = document.createElement('script');
      script.src = `${GOOGLE_MAPS_SCRIPT_ORIGIN}?${params.toString()}`;
      script.async = true;
      script.onerror = () => {
        // Un prochain montage de <MapView> doit pouvoir réessayer (réseau coupé, blocage).
        mapsLoadPromise = undefined;
        delete globalScope[READY_CALLBACK_NAME];
        reject(new Error('@babana/maps: chargement de Google Maps JavaScript échoué.'));
      };
      document.head.appendChild(script);
    });
  }
  return mapsLoadPromise;
}

/** Réservé aux tests. */
export function _resetGoogleMapsLoaderForTests(): void {
  mapsLoadPromise = undefined;
}
