/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { onlineHeadlessTask } from './src/onlineTask';
import { installBackgroundPushHandlers } from './src/push/firebase';

// Notification push reçue app fermée (15 novembre) : enregistré avant tout composant, comme Firebase l'exige.
installBackgroundPushHandlers();
AppRegistry.registerComponent(appName, () => App);
// Tâche du service de premier plan d'un chauffeur en ligne (android/.../online/OnlineService.kt).
AppRegistry.registerHeadlessTask('BabanaDriverOnline', () => () => onlineHeadlessTask());
