/**
 * Double de test pour `@react-native-community/geolocation` (L6-13, étendu par L6-05) -- module
 * natif, pas de double officiel fourni par le paquet. Même raison que
 * `__mocks__/react-native-maps.tsx` : `src/location/oneShot.ts` (et `src/location/tracker.ts`
 * depuis L6-05) sont importés transitivement dès qu'un écran ou un test monte ActiveRideScreen ;
 * ce fichier, adjacent à `node_modules` (racine du paquet `@babana/driver`), est appliqué par
 * Jest automatiquement, sans `jest.mock()` explicite. Les tests qui exercent vraiment la position
 * mockent `../location` (ou `@react-native-community/geolocation` directement, `tracker.test.ts`)
 * plutôt que de dépendre de ce double.
 */
function getCurrentPosition(success) {
  success({ coords: { latitude: 0, longitude: 0 } });
}

function requestAuthorization() {}

module.exports = { getCurrentPosition, requestAuthorization };
module.exports.default = module.exports;
