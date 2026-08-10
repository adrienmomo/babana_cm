const { encodePolyline } = require('./polyline');

const EARTH_RADIUS_METERS = 6_371_000;

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Coefficient route/vol d'oiseau et vitesse moyenne : valeurs plausibles marquées provisoires
 * (D21), pas des mesures réelles. Codées en dur ici volontairement -- ce service est un mock de
 * développement qui refuse de démarrer en production (garde-fou NODE_ENV), l'invariant 5 vise
 * le code qui tourne réellement en production.
 */
const ROAD_DISTANCE_FACTOR = 1.3;
const AVERAGE_SPEED_KMH = 25; // trafic urbain camerounais, modèle voiture (É8, pas de deux-roues)

/**
 * Réponse déterministe dérivée de la distance à vol d'oiseau, pour toute paire de points --
 * connue ou non (critère d'acceptation 1 de L0-08). Même entrée, même sortie, toujours : les
 * tests qui en dépendent ne doivent jamais dépendre d'une liste exhaustive de trajets connus.
 */
function buildRoute(origin, destination) {
  const beelineMeters = haversineMeters(origin, destination);
  const distanceMeters = Math.round(beelineMeters * ROAD_DISTANCE_FACTOR);
  const durationSeconds = Math.round((distanceMeters / 1000 / AVERAGE_SPEED_KMH) * 3600);
  const polyline = encodePolyline([
    [origin.latitude, origin.longitude],
    [destination.latitude, destination.longitude],
  ]);
  return { distanceMeters, durationSeconds, polyline };
}

module.exports = { haversineMeters, buildRoute };
