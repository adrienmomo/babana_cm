// root: true retiré volontairement : cette configuration doit se combiner avec le .eslintrc.cjs
// de la racine du monorepo, qui porte la règle de frontière propre à ce paquet (aucun import du
// SDK de carte hors de src/providers/, L6-01) -- voir code/.eslintrc.cjs.
module.exports = {
  extends: '@react-native',
};
