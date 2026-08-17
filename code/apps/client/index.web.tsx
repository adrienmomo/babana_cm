/**
 * Point d'entrée web (D22, L6-00 critère d'acceptation 6). Export complet -- déploiement,
 * bannière de dégradation, fournisseur de carte web -- c'est L6-18 ; ce fichier n'existe ce soir
 * que pour prouver que `App.tsx` (donc la navigation, L6-00) se bundle pour le web sans
 * modification d'écran.
 *
 * Exclu de `tsconfig.json` (racine du paquet, `lib` sans DOM -- `@react-native/typescript-config`
 * cible le runtime natif) : `document` n'y est pas typable sans ajouter la lib DOM à *tout*
 * l'app, ce qui masquerait un usage DOM dans un écran natif. Le bundle web réel est vérifié par
 * `npm run build:web` (Babel, pas tsc) ; L6-18, qui possède l'outillage web complet, est le bon
 * endroit pour poser un `tsconfig.web.json` dédié si ce fichier grandit.
 *
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

AppRegistry.runApplication(appName, {
  rootTag: document.getElementById('root'),
});
