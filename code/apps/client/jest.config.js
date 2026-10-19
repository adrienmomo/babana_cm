module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: [
    'react-native-safe-area-context/jest/mock',
  ],
  // Même paquet, publié uniquement en ESM (voir packages/api-client/jest.config.js pour le
  // détail) -- sans cette extension, le charger fait échouer le require() CommonJS de Jest.
  // @react-navigation/* (L6-00) est dans le même cas : publié en ESM seulement.
  // @react-native-async-storage/async-storage (L6-06, via @babana/api-client createRealtimeClient
  // -> createAsyncStorageActionQueue, requis dès la construction du client temps réel, avant même
  // toute connexion) -- même paquet, même raison que packages/api-client/jest.config.js.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|@react-native-async-storage)/)',
  ],
};
