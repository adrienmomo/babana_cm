/**
 * Double de test pour `@react-native-community/geolocation` (L6-06) -- module natif, pas de
 * double officiel fourni par le paquet. Même raison que `__mocks__/react-native-maps.tsx` :
 * `src/location.ts` est importé transitivement dès qu'un écran ou un test monte HomeScreen ; ce
 * fichier, adjacent à `node_modules` (racine du paquet `@babana/client`), est appliqué par Jest
 * automatiquement, sans `jest.mock()` explicite. Les tests qui exercent vraiment la position
 * (`location.test.ts`) mockent `../location` directement plutôt que de dépendre de ce double.
 */
function getCurrentPosition(success) {
  success({ coords: { latitude: 0, longitude: 0 } });
}

function requestAuthorization() {}

module.exports = { getCurrentPosition, requestAuthorization };
module.exports.default = module.exports;
