import { mapGeolocationErrorCode, type LocationResult } from './location.types';

export type { LocationResult, LocationFailureReason } from './location.types';

/**
 * Équivalent web de `location.ts` (L6-06, D22) -- l'API `navigator.geolocation` standard du
 * navigateur, qui affiche elle-même sa propre invite de permission. Aucune permission native à
 * demander ici, contrairement à Android. Mêmes codes d'erreur W3C que le natif
 * (`mapGeolocationErrorCode`, `location.types.ts`) : une seule table de correspondance.
 */
export async function getCurrentPosition(): Promise<LocationResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { status: 'error', reason: 'position-unavailable' };
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
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
