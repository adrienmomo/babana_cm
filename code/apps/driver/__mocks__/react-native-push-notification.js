/**
 * Double de test pour `react-native-push-notification` (L6-12, `proposalAlert.ts`) -- même
 * discipline que `react-native-maps.tsx` dans ce même dossier (voir ce fichier pour le détail du
 * raisonnement) : adjacent à `node_modules` (racine du paquet `@babana/driver`), Jest l'applique
 * automatiquement, sans `jest.mock()` explicite dans chaque fichier de test.
 *
 * Nécessaire : le module réel construit un `NativeEventEmitter` dès son chargement (via
 * `@react-native-community/push-notification-ios`), qui échoue en environnement de test faute de
 * module natif -- même famille de problème que `@react-native-google-signin/google-signin`
 * (`jest.config.js`), à ceci près qu'aucun mock officiel n'est publié pour ce paquet-ci.
 */
function configure() {}
function createChannel(_channel, callback) {
  if (callback) callback(true);
}
function localNotification() {}
function cancelLocalNotification() {}
function cancelLocalNotifications() {}
function unregister() {}

const Importance = {
  DEFAULT: 3,
  HIGH: 4,
  LOW: 2,
  MIN: 1,
  NONE: 0,
  UNSPECIFIED: -1000,
};

module.exports = {
  configure,
  createChannel,
  localNotification,
  cancelLocalNotification,
  cancelLocalNotifications,
  unregister,
  Importance,
};
