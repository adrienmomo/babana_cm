import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import { mapGeolocationErrorCode, type LocationResult } from './location.types';

export type { LocationResult, LocationFailureReason } from './location.types';

/**
 * Position ponctuelle du client au chargement de HomeScreen (L6-06) -- native (iOS/Android).
 * `location.web.ts` porte l'équivalent web (extension de plateforme résolue par webpack ET par
 * Metro, même mécanisme que le reste du monorepo pour D22 -- aucun `Platform.OS === 'web'` dans
 * un écran).
 *
 * Un échec ne rejette jamais : `{ status: 'error', reason }` -- HomeScreen ouvre alors sur
 * Douala par défaut, le client désigne son départ à la main (spécification L6-06). `reason`
 * distingue les trois causes (doute §2, 23 août) : l'écran ne doit plus les confondre.
 */

async function ensurePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    // iOS : la boîte de dialogue système s'affiche au premier appel de getCurrentPosition ;
    // requestAuthorization() la déclenche explicitement plutôt que d'attendre ce premier appel,
    // sans quoi getCurrentPosition échouerait silencieusement avant que l'utilisateur n'ait pu
    // répondre (NSLocationWhenInUseUsageDescription, Info.plist).
    Geolocation.requestAuthorization();
    return true;
  }
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: 'Position',
    message: 'Babana utilise votre position pour centrer la carte et proposer votre point de départ.',
    buttonPositive: 'Autoriser',
    buttonNegative: 'Refuser',
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

export async function getCurrentPosition(): Promise<LocationResult> {
  const allowed = await ensurePermission();
  if (!allowed) return { status: 'error', reason: 'permission-denied' };

  return new Promise((resolve) => {
    Geolocation.getCurrentPosition(
      (position) =>
        resolve({
          status: 'success',
          position: { latitude: position.coords.latitude, longitude: position.coords.longitude },
        }),
      (error) => resolve({ status: 'error', reason: mapGeolocationErrorCode(error?.code) }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}
