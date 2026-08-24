module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: [
    'react-native-safe-area-context/jest/mock',
    // @babana/api-client charge @react-native-google-signin/google-signin dès qu'on l'importe
    // (pas seulement quand on l'appelle) -- son module natif fait
    // TurboModuleRegistry.getEnforcing() au chargement même, donc même un test qui ne fait
    // qu'importer (jest.requireActual) a besoin du double officiel du module natif, pas
    // seulement de la permission de parser le paquet (transformIgnorePatterns, ci-dessous).
    // Chemin direct dans packages/api-client/node_modules : c'est là, et seulement là, que ce
    // paquet s'installe dans ce monorepo (vérifié -- pas hoisté à la racine).
    '<rootDir>/../../packages/api-client/node_modules/@react-native-google-signin/google-signin/jest/build/jest/setup.js',
  ],
  // Même paquet, publié uniquement en ESM (voir packages/api-client/jest.config.js pour le
  // détail) -- sans cette extension, le charger fait échouer le require() CommonJS de Jest.
  // @react-navigation/* (L6-00) est dans le même cas : publié en ESM seulement.
  // @react-native-async-storage/async-storage (L6-11, via @babana/api-client createRealtimeClient
  // -> createAsyncStorageActionQueue, requis dès la construction du client temps réel, avant même
  // toute connexion -- même raison, même correctif que apps/client/jest.config.js) -- même
  // paquet, même raison que packages/api-client/jest.config.js.
  //
  // react-native-push-notification (L6-12) n'a pas besoin d'entrer ici : `__mocks__/
  // react-native-push-notification.js` le remplace entièrement avant même que Jest n'ait à le
  // parser (même patron que `__mocks__/react-native-maps.tsx`, déjà dans ce dossier).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-google-signin|@react-navigation|@react-native-async-storage)/)',
  ],
};
