module.exports = {
  preset: '@react-native/jest-preset',
  // Le préréglage RN ne transpile que react-native/@react-native(-community) par défaut ;
  // @react-native-async-storage/async-storage (L6-04) publie uniquement un build ESM -- sans cette
  // extension, `import`/`export` au sein du paquet fait échouer le require() CommonJS de Jest.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-async-storage)/)',
  ],
};
