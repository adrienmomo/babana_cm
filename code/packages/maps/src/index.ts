export * from './types';
export { MapView } from './MapView';
export { openNavigation } from './navigation';
export { searchPlace, reverseGeocode } from './places';

// Injection de la clé Google Maps pour les appels REST (Places, Geocoding) -- voir
// providers/google/config.ts. Ce ré-export nomme la fonction d'après le paquet, pas le
// fournisseur : L6-18 (fournisseur web) devra généraliser ce point de configuration, pas les
// écrans qui l'appellent au démarrage (même règle que activeProvider.ts).
export { configureGoogleMapsProvider as configureMapsProvider } from './providers/google';
