module.exports = {
  preset: '@react-native/jest-preset',
  // react-native-maps n'expose pas de mock jest par défaut (contrairement aux modules natifs déjà
  // couverts par le preset) -- __mocks__/react-native-maps.tsx fournit une carte factice, activée
  // explicitement par jest.mock('react-native-maps') dans les tests qui en ont besoin (le seul
  // test qui rend réellement <MapView>, providers/google/MapView.test.tsx) : le reste du paquet
  // (navigation, places, fournisseur vide) n'a besoin d'aucun SDK réel (critère d'acceptation 4,
  // L6-01) et ne le charge donc jamais.
};
