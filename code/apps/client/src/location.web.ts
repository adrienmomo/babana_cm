import type { LatLng } from '@babana/maps';

/**
 * Équivalent web de `location.ts` (L6-06, D22) -- l'API `navigator.geolocation` standard du
 * navigateur, qui affiche elle-même sa propre invite de permission. Aucune permission native à
 * demander ici, contrairement à Android.
 */
export async function getCurrentPosition(): Promise<LatLng | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}
