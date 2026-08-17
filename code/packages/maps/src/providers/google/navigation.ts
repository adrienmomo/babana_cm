import { AppState, Linking } from 'react-native';
import type { LatLng, NavigationOptions } from '../../types';

/**
 * Lien profond Google Maps (D12) : v1 ouvre l'app externe, v2 (SDK embarqué) remplacera
 * seulement ce fichier -- `openNavigation` garde la même signature (critère d'acceptation 3).
 */
function buildGoogleMapsUrl(destination: LatLng): string {
  return (
    'https://www.google.com/maps/dir/?api=1' +
    `&destination=${destination.latitude},${destination.longitude}` +
    '&travelmode=driving'
  );
}

/**
 * Approxime la fin du guidage par le retour au premier plan de l'app après l'avoir quittée pour
 * Google Maps -- il n'existe aucun rapport d'arrivée réel à observer depuis un lien profond
 * (contrairement à un SDK embarqué, v2). Un aller-retour minimal (quitte puis revient) est exigé
 * pour éviter de déclencher `onComplete` si `AppState` émet un événement parasite sans que
 * l'utilisateur ait réellement quitté l'app.
 */
function callOnceAppReturnsToForeground(onComplete: () => void): void {
  let hasLeft = false;
  const subscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      hasLeft = true;
      return;
    }
    if (hasLeft) {
      subscription.remove();
      onComplete();
    }
  });
}

export function openNavigation(destination: LatLng, options: NavigationOptions = {}): void {
  const url = buildGoogleMapsUrl(destination);
  Linking.openURL(url)
    .then(() => {
      if (options.onComplete) callOnceAppReturnsToForeground(options.onComplete);
    })
    .catch(() => {
      // Aucune app Maps installée et le navigateur a aussi échoué à ouvrir le lien -- rien de
      // plus à faire à ce niveau : aucun écran n'existe encore pour afficher une erreur (L6-01),
      // à traiter par l'écran qui appellera cette fonction (L6-13).
    });
}
