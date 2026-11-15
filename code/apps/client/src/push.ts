import { PermissionsAndroid, Platform } from 'react-native';
import { getMessaging, getToken, onTokenRefresh } from '@react-native-firebase/messaging';
import { createPushRegistrar, type PushBinding } from '@babana/api-client';
import { apiClient } from './auth';

/**
 * Notifications push du client par Firebase (15 novembre, réponse du maître d'ouvrage : chauffeur
 * affecté, arrivé, course terminée). Le serveur les envoie ; app fermée ou en arrière-plan,
 * Android les affiche ; app à l'écran, rien de plus -- l'écran de suivi le dit déjà. Une
 * notification touchée ouvre l'app, qui rouvre d'elle-même le suivi (`rideResume.ts`).
 * Sans configuration Firebase (code/docs/firebase.md), pas de jeton : rien ne casse.
 *
 * Web : `push.web.ts` (aucune notification push dans l'export web).
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
