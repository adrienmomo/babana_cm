/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { onlineHeadlessTask } from './src/onlineTask';

AppRegistry.registerComponent(appName, () => App);
// Tâche du service de premier plan d'un chauffeur en ligne (android/.../online/OnlineService.kt).
AppRegistry.registerHeadlessTask('BabanaDriverOnline', () => () => onlineHeadlessTask());
