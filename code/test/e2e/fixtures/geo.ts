// Coordonnées partagées par tous les scénarios de L10-01, à rester dans le rayon par défaut de
// nearby.subscribe (5 km) sans avoir à le préciser à chaque appel.
//
// **Point DISTINCT de celui de test/concurrency et test/http-contract, volontairement** (D72/D73,
// amoa/01-architecture.md §9 quindecies -- avant cette tâche, les trois partageaient exactement
// (4.05, 9.70)). `node --test` lance ces suites dans des processus concurrents, mesuré, et
// chacune amenait un chauffeur réellement en ligne sur le même point Redis exact -- jusqu'à 7 à
// la fois. Le géo-index (redis/geo-index.ts::findNearby) ne garde que les 5 premiers par score, et
// pour des points RIGOUREUSEMENT identiques ce score est à égalité parfaite : Redis départage
// alors par ordre lexicographique de l'identifiant, jamais par ordre d'arrivée -- un chauffeur
// resté dehors n'apparaissait alors JAMAIS dans nearby.drivers, quelle que soit la durée
// d'attente ("chauffeur jamais apparu... après 20000ms", le symptôme catalogué par D72). Aucun
// tarif ni trajet ne dépend de la position absolue (mock de routage dérivé de la seule distance,
// une unique zone par défaut) -- ce déplacement n'a donc aucun effet sur ce que ces scénarios
// vérifient.
export const ORIGIN = { latitude: 4.13, longitude: 9.83 };
export const DESTINATION = { latitude: 4.14, longitude: 9.84 };

// Point distinct du trajet, utilisé pour prouver que le suivi (`ride.track`) reflète bien une
// position qui CHANGE -- pas seulement la première position d'enregistrement (`bringDriverOnline`
// l'a déjà émise avant même la proposition).
export const EN_ROUTE_POSITION = { latitude: 4.132, longitude: 9.833 };
