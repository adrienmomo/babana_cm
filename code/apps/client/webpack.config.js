const path = require('node:path');

/**
 * Export web (D22, complété par L6-18). `App.tsx` (donc `AppNavigator`, `@react-navigation/*`,
 * `react-native-screens`) se bundle pour le web sans modification d'écran (L6-00, critère
 * d'acceptation 6) ; L6-18 y ajoute le vrai fournisseur de carte, le vrai flux d'authentification
 * et un stockage de session en mémoire -- tous trois dans les paquets partagés, jamais ici.
 *
 * `resolve.alias` fait porter la différence de plateforme au niveau du bundler, jamais dans un
 * écran (même règle que `@babana/maps`/`@babana/ui`, D22) : tout `import ... from 'react-native'`
 * résout vers `react-native-web`, sans qu'aucun fichier applicatif n'ait à le savoir. Les deux
 * bouchons qui vivaient ici (`react-native-maps$`, `react-native-keychain$`) ont disparu avec
 * L6-18 : `packages/maps/src/activeProvider.web.ts` et `packages/api-client/src/auth/
 * tokenStorage.web.ts` routent désormais eux-mêmes vers un fournisseur web réel, résolus par
 * `resolve.extensions` ci-dessous -- plus aucun fichier du bundle web n'importe
 * `react-native-maps` ou `react-native-keychain`.
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
    },
  },
  module: {
    rules: [
      // Nécessaire pour @react-navigation/* et react-native-screens : leurs builds ESM
      // (lib/module/) importent des fichiers voisins sans extension, ce que webpack 5 refuse par
      // défaut pour de l'ESM strict.
      { test: /\.m?js$/, resolve: { fullySpecified: false } },
      // @react-navigation/elements embarque ses icônes (flèche retour, loupe, croix) comme
      // imports `.png` -- sans règle d'asset, webpack 5 refuse de les charger ("no loaders are
      // configured to process this file"), et le bundle ne se termine même pas.
      { test: /\.(png|jpe?g|gif|svg)$/, type: 'asset/resource' },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules\/(?!(react-native-web|@react-navigation|react-native-screens|react-native-safe-area-context)\/)/,
        // Sans ce `type` explicite, webpack déduit `javascript/esm` pour les paquets ci-dessus
        // (leurs fichiers `lib/module/*.js` contiennent de la syntaxe `export`/`import`, et
        // aucun n'a `"type": "module"` dans son `package.json` pour le dire clairement) --
        // mais babel-loader les transforme quand même en CommonJS (`@react-native/babel-preset`
        // ne désactive pas cette transformation pour un `caller` non-Metro). Le résultat : du
        // code `exports.x = ...` exécuté dans un wrapper de module ESM qui ne fournit jamais
        // `exports` comme variable libre -- `ReferenceError: exports is not defined` au premier
        // `import` de `@react-navigation/native`, avant même que `AppNavigator` ne s'affiche.
        // `javascript/auto` fait correspondre le type de module à ce que babel produit
        // réellement, pas à ce que le fichier source donnait à deviner.
        type: 'javascript/auto',
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
