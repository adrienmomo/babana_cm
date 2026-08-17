module.exports = {
  preset: '@react-native/jest-preset',
  // Le préréglage RN ne transpile que react-native/@react-native(-community) par défaut ;
  // @react-native-google-signin publie uniquement un build ESM (`exports.default` pointe sur
  // `lib/module/`, pas de condition `require`) -- sans cette extension, `import`/`export` au sein
  // du paquet fait échouer le require() CommonJS de Jest ("Unexpected token 'export'").
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-native-google-signin)/)',
  ],
  // Mock officiel du module natif, fourni par la bibliothèque elle-même -- la logique JS réelle
  // de GoogleSignin.signIn()/hasPlayServices() s'exécute par-dessus (test/googleSignIn.test.ts,
  // L6-02 critère d'acceptation 4 : testable sans SDK réel). Chemin de fichier direct, pas un
  // spécificateur de paquet : la "exports" map de ce paquet ne publie pas "./jest/build/...",
  // seule une résolution par chemin la contourne (vérifié -- la résolution par spécificateur
  // échoue avec "Module ... was not found").
  setupFiles: [
    '<rootDir>/node_modules/@react-native-google-signin/google-signin/jest/build/jest/setup.js',
  ],
};
