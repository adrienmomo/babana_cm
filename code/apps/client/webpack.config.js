const path = require('node:path');

/**
 * Export web (D22) -- ce fichier ne fait la preuve, ce soir (L6-00, critère d'acceptation 6),
 * que d'une chose : `App.tsx` (donc `AppNavigator`, donc `@react-navigation/*` et
 * `react-native-screens`) se bundle pour le web sans modification d'écran. Le déploiement réel
 * (Vercel, prévisualisation par branche, `vercel.json`) est L6-18 -- ce fichier est repris et
 * complété là-bas, pas remplacé (même arborescence de fichiers que sa spécification l'annonce).
 *
 * `resolve.alias` fait porter la différence de plateforme au niveau du bundler, jamais dans un
 * écran (même règle que `@babana/maps`/`@babana/ui`, D22) : tout `import ... from 'react-native'`
 * résout vers `react-native-web`, sans qu'aucun fichier applicatif n'ait à le savoir.
 */
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: path.resolve(__dirname, 'index.web.tsx'),
  output: {
    path: path.resolve(__dirname, 'dist-web'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
    alias: {
      'react-native$': 'react-native-web',
      // Provisoire, condamné par L6-18 (`packages/maps/src/providers/web/`, "troisième
      // implémentation") : le SDK natif de carte n'a pas d'équivalent web et
      // `@babana/maps/src/activeProvider.ts` ne sait pas encore choisir un fournisseur selon la
      // plateforme -- c'est exactement le travail que L6-18 doit faire. Cet alias ne fait que
      // permettre au bundle de se construire ce soir (critère d'acceptation 6) sans toucher
      // `packages/maps` ; à retirer quand `activeProvider.ts` route lui-même vers un fournisseur
      // web réel.
      'react-native-maps$': path.resolve(__dirname, 'webpack-stubs/react-native-maps.web.js'),
    },
  },
  module: {
    rules: [
      // Nécessaire pour @react-navigation/*, react-native-screens et le fournisseur web du SDK
      // Google Sign-In : leurs builds ESM (lib/module/) importent des fichiers voisins sans
      // extension, ce que webpack 5 refuse par défaut pour de l'ESM strict.
      { test: /\.m?js$/, resolve: { fullySpecified: false } },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules\/(?!(react-native-web|@react-navigation|react-native-screens|react-native-safe-area-context|@react-native-google-signin)\/)/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['module:@react-native/babel-preset'],
          },
        },
      },
    ],
  },
};
