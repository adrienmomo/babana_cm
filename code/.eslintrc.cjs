// Racine de la configuration ESLint du monorepo (L0-03). Porte les deux règles de frontière de
// amoa/04-monorepo-et-services.md §8 qui touchent au lot de cette nuit -- vérifiées
// mécaniquement, pas seulement en revue de code (CLAUDE.md, "Frontières, vérifiées par le
// lint"). apps/client/.eslintrc.js et apps/driver/.eslintrc.js n'ont plus `root: true` pour se
// combiner avec cette configuration plutôt que de l'ignorer.
const MAP_SDK_IMPORT_MESSAGE =
  "apps/* n'importe aucun SDK de carte directement -- seulement @babana/maps (C3, D13).";

module.exports = {
  root: true,
  overrides: [
    {
      files: ['apps/**/*.{js,jsx,ts,tsx}'],
      excludedFiles: ['apps/**/node_modules/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'react-native-maps', message: MAP_SDK_IMPORT_MESSAGE },
              { name: 'react-native-google-maps', message: MAP_SDK_IMPORT_MESSAGE },
              { name: 'expo-maps', message: MAP_SDK_IMPORT_MESSAGE },
              { name: '@react-native-mapbox-gl/maps', message: MAP_SDK_IMPORT_MESSAGE },
            ],
          },
        ],
      },
    },
    {
      // services/realtime n'existe pas encore avec sa propre configuration ESLint ce soir
      // (arrive avec L0-04) ; la règle est posée maintenant pour s'appliquer dès sa création,
      // exactement comme le tableau des frontières de CLAUDE.md l'exige.
      files: ['services/realtime/**/*.{js,ts}'],
      excludedFiles: ['services/realtime/**/node_modules/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@babana/ui', '@babana/maps', '**/apps/*', '../apps/*', '../../apps/*'],
                message: "services/realtime ne dépend d'aucun paquet de apps/* (le service ne sait rien de l'interface).",
              },
            ],
          },
        ],
      },
    },
  ],
};
