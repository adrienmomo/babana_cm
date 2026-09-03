// Coordonnées partagées par tous les scénarios de L10-01 -- mêmes valeurs que test/concurrency
// et test/http-contract (Akwa, Douala), pour rester dans le rayon par défaut de nearby.subscribe
// (5 km) sans avoir à le préciser à chaque appel.
export const ORIGIN = { latitude: 4.05, longitude: 9.7 };
export const DESTINATION = { latitude: 4.06, longitude: 9.71 };

// Point distinct du trajet, utilisé pour prouver que le suivi (`ride.track`) reflète bien une
// position qui CHANGE -- pas seulement la première position d'enregistrement (`bringDriverOnline`
// l'a déjà émise avant même la proposition).
export const EN_ROUTE_POSITION = { latitude: 4.052, longitude: 9.703 };
