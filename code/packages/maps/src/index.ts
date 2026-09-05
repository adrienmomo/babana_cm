export * from './types';
export { MapView } from './MapView';
export { openNavigation } from './navigation';
export { searchPlace, reverseGeocode } from './places';

// Injection de la clé Google Maps pour les appels REST (Places, Geocoding) -- voir
// providers/google/config.ts. Ce ré-export nomme la fonction d'après le paquet, pas le
// fournisseur : le fournisseur web (L6-18) réutilise directement la même configuration (aucune
// clé Google distincte pour son SDK JavaScript -- providers/web/loadGoogleMaps.ts).
//
// Importé depuis './providers/google/config' -- jamais depuis './providers/google' (le barrel du
// fournisseur, qui réexporte aussi MapView.tsx et navigation.ts) : ce dernier importe
// react-native-maps dès l'évaluation du module, ce qui l'aurait tiré dans le bundle web pour la
// seule configuration d'une clé REST qui n'a besoin d'aucun SDK natif (L6-18, critère
// d'acceptation 6 -- webpack.config.js n'a donc plus besoin d'alias vers ce module sur le web).
export { configureGoogleMapsProvider as configureMapsProvider } from './providers/google/config';
