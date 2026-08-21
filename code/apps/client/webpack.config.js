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
      // Même raisonnement, même sort (L6-18) : le trousseau iOS / Keystore Android
      // (`packages/api-client/src/auth/tokenStorage.ts`, L6-02) n'a pas d'équivalent web non
      // plus. Sans cet alias, la restauration de session (`AuthClient.restore()`, appelée dès le
      // montage de `AppNavigator`) lève au premier chargement -- le bundle se construit (critère
      // 6) mais l'app ne dépasse jamais l'écran de chargement. Le stub chiffre... rien : il pose
      // en clair dans `localStorage`, ce que L6-18 devra remplacer par quelque chose de réellement
      // sûr (une session web n'a pas de trousseau système à qui déléguer) avant tout déploiement.
      'react-native-keychain$': path.resolve(__dirname, 'webpack-stubs/react-native-keychain.web.js'),
    },
  },
  module: {
    rules: [
      // Nécessaire pour @react-navigation/*, react-native-screens et le fournisseur web du SDK
      // Google Sign-In : leurs builds ESM (lib/module/) importent des fichiers voisins sans
      // extension, ce que webpack 5 refuse par défaut pour de l'ESM strict.
      { test: /\.m?js$/, resolve: { fullySpecified: false } },
      // @react-navigation/elements embarque ses icônes (flèche retour, loupe, croix) comme
      // imports `.png` -- sans règle d'asset, webpack 5 refuse de les charger ("no loaders are
      // configured to process this file"), et le bundle ne se termine même pas.
      { test: /\.(png|jpe?g|gif|svg)$/, type: 'asset/resource' },
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules\/(?!(react-native-web|@react-navigation|react-native-screens|react-native-safe-area-context|@react-native-google-signin)\/)/,
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
