import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';

/**
 * Position ponctuelle du chauffeur, à la demande (L6-13).
 *
 * **Une lecture unique, pas une capture continue.** La capture GPS continue -- fréquence
 * adaptative, agrégation, arrière-plan -- est L6-05, non construite. Ce module ne fournit qu'un
 * relevé à l'instant, pour le seul besoin qui ne peut pas attendre : le bouton d'urgence (L8-04),
 * qui doit joindre une position à son alerte. Le choix « rappeler le GPS maintenant » plutôt que
 * « réutiliser la dernière position » est délibéré : il n'existe aujourd'hui aucune « dernière
 * position en vol » (l'app n'émet encore aucun `position.update`, L6-05), et au moment d'une
 * urgence la position la plus fraîche possible vaut mieux qu'une position d'il y a quelques
 * minutes issue d'une cadence qu'on aurait ralentie pour la batterie.
 *
 * Ne rejette jamais : `null` si la permission est refusée ou le GPS indisponible -- l'appelant
 * (EmergencyButton) affiche alors « Position indisponible », jamais une position inventée.
 */
export async function getCurrentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  const allowed = await ensurePermission();
  if (!allowed) return null;

  return new Promise((resolve) => {
    Geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}

async function ensurePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    Geolocation.requestAuthorization();
    return true;
  }
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: 'Position',
    message: "Babana joint votre position à une alerte d'urgence.",
    buttonPositive: 'Autoriser',
    buttonNegative: 'Refuser',
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}
