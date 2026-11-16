import { PermissionsAndroid, Platform } from 'react-native';
import { getMessaging, getInitialNotification, getToken, onNotificationOpenedApp, onTokenRefresh, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import { createPushRegistrar, type PushBinding } from '@babana/api-client';
import { apiClient } from '../auth';
import { alertIncomingProposal, configureProposalAlerts } from '../proposalAlert';
import { handleProposalPushMessage, type ProposalPushData } from './handlers';

/**
 * Notifications push du chauffeur par Firebase (15 novembre) : le jeton d'appareil enregistré à
 * la connexion (`registerDeviceToken`, L7-01), une proposition reçue app fermée qui sonne, et une
 * notification touchée qui ouvre la proposition (`handlers.ts`). Sans configuration Firebase
 * (`google-services.json` absent, code/docs/firebase.md), tout échoue en silence : pas de jeton,
 * le WebSocket et le service de premier plan restent le canal des propositions.
 */
const firebaseBinding: PushBinding = {
  async requestPermission() {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  },
  async getToken() {
    try {
      return await getToken(getMessaging());
    } catch {
      return null;
    }
  },
  onTokenRefresh(listener) {
    try {
      return onTokenRefresh(getMessaging(), listener);
    } catch {
      return () => undefined;
    }
  },
};

export const pushRegistrar = createPushRegistrar({ apiClient, binding: firebaseBinding, platform: 'android' });

function isProposal(data: { [key: string]: unknown } | undefined): data is { [key: string]: unknown } & ProposalPushData {
  return data?.type === 'proposal';
}

/** Appelé une fois, au chargement du module JS (`index.js`), avant tout écran. */
export function installBackgroundPushHandlers(): void {
  try {
    setBackgroundMessageHandler(getMessaging(), async (message) => {
      // App fermée et service de premier plan arrêté : la proposition sonne quand même.
      if (isProposal(message.data)) {
        configureProposalAlerts();
        alertIncomingProposal(typeof message.data.expiresAt === 'string' ? message.data.expiresAt : null);
      }
    });
  } catch {
    // Firebase non configuré : rien à installer.
  }
}

/** Une notification touchée (app en arrière-plan ou fermée) ouvre la proposition. */
export function routeOpenedNotifications(): void {
  try {
    const messaging = getMessaging();
    onNotificationOpenedApp(messaging, (message) => {
      if (isProposal(message.data)) handleProposalPushMessage(message.data);
    });
    getInitialNotification(messaging)
      .then((message) => {
        if (message && isProposal(message.data)) handleProposalPushMessage(message.data);
      })
      .catch(() => undefined);
  } catch {
    // Firebase non configuré.
  }
}
