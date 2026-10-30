const { haversineMeters } = require('./routing');

/**
 * Géocodage inverse simulé (D19) : le repère de la fixture le plus proche du point, sous la forme
 * de l'API Geocoding de Google (`status`, `results[].formatted_address`) -- l'app lit la même
 * réponse qu'en production, seule l'adresse change. Au-delà de `maxDistanceMeters`, `ZERO_RESULTS`,
 * comme Google hors de toute adresse connue : l'app retombe alors sur les coordonnées.
 */
const MAX_DISTANCE_METERS = 3000;

function nearestPlace(places, point, maxDistanceMeters = MAX_DISTANCE_METERS) {
  let best = null;
  for (const place of places) {
    const distance = haversineMeters(point, place);
    if (distance <= maxDistanceMeters && (best === null || distance < best.distance)) {
      best = { place, distance };
    }
  }
  return best ? best.place : null;
}

function geocodeResponse(places, point) {
  const place = nearestPlace(places, point);
  return place
    ? { status: 'OK', results: [{ formatted_address: `${place.name}, Douala` }] }
    : { status: 'ZERO_RESULTS', results: [] };
}

module.exports = { nearestPlace, geocodeResponse, MAX_DISTANCE_METERS };
