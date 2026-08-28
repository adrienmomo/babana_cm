import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';

/**
 * Permissions de localisation (L6-05) : premier plan (nécessaire à toute lecture GPS) et
 * arrière-plan (nécessaire à la capture continue une fois l'app reléguée derrière une carte de
 * navigation -- spécification, « l'arrière-plan comme cas normal »).
 *
 * **Un refus ne bloque jamais l'app** (critère d'acceptation 5) : ce module ne lève jamais,
 * il renvoie un état que l'appelant (`tracker.ts`) traduit en « pas de capture », jamais en
 * exception qui remonterait jusqu'à un écran.
 */

export type PermissionState = 'granted' | 'denied';

/**
 * Permission de premier plan -- la seule qui existait déjà (`location.ts`, devenu
 * `location/oneShot.ts`, pour le bouton d'urgence L8-04). Centralisée ici pour que la capture
 * continue et la lecture ponctuelle partagent la même logique, jamais deux implémentations qui
 * pourraient diverger.
 */
export async function ensureForegroundPermission(): Promise<PermissionState> {
  if (Platform.OS !== 'android') {
    // iOS : requestAuthorization() est fire-and-forget côté @react-native-community/geolocation
    // (pas de callback de résultat dans cette version) -- la vraie réponse arrive au premier
    // GetCurrentPosition/watchPosition, qui échoue proprement si refusée (voir tracker.ts).
    Geolocation.requestAuthorization();
    return 'granted';
  }
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: 'Position',
    message: 'Babana a besoin de votre position pour vous proposer des courses.',
    buttonPositive: 'Autoriser',
    buttonNegative: 'Refuser',
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
}

/**
 * Permission d'arrière-plan (Android 10+, `ACCESS_BACKGROUND_LOCATION`) -- distincte de la
 * permission de premier plan depuis Android 10, et Android exige qu'elle soit demandée
 * SÉPARÉMENT, après que la permission de premier plan a déjà été accordée (une demande groupée
 * est refusée par le système sur les versions récentes). N'est donc jamais appelée seule --
 * `tracker.ts` l'appelle uniquement après un succès de `ensureForegroundPermission`.
 *
 * Un refus laisse la capture au premier plan fonctionner normalement (spécification : un refus
 * ne bloque rien) -- seule la continuité en arrière-plan en pâtit, dégradation explicite plutôt
 * qu'un échec.
 */
export async function ensureBackgroundPermission(): Promise<PermissionState> {
  if (Platform.OS !== 'android') {
    // iOS n'a pas d'équivalent direct dans cette version de @react-native-community/geolocation
    // (la distinction "when in use" / "always" se règle par Info.plist + un second appel natif
    // hors de portée de ce paquet) -- non modélisé ici, signalé dans amoa/questions/L6-05.md.
    return 'denied';
  }
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION, {
    title: 'Position en arrière-plan',
    message:
      'Babana continue de partager votre position pendant que vous naviguez avec une autre application, tant que vous êtes en ligne.',
    buttonPositive: 'Autoriser',
    buttonNegative: 'Refuser',
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
}
