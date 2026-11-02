import { ApiError, translateApiError } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { apiClient, signOut } from './auth';
import { locationTracker } from './location';
import { realtimeClient } from './realtime';

export type DriverSignOutOutcome = { signedOut: true } | { signedOut: false; message: string };

/**
 * Déconnexion volontaire du chauffeur (écran de profil). En ligne, il passe d'abord hors ligne,
 * par le même chemin que la bascule (`AvailabilityToggle.tsx` : Odoo autorise, puis
 * `availability.set`, puis la capture GPS s'arrête) -- sinon il resterait dans le vivier et
 * recevrait une proposition sur un téléphone déconnecté. Un refus du serveur (course en cours)
 * arrête tout et rend son motif.
 *
 * Sans réseau, la déconnexion locale reste possible (même règle que `AuthClient.logout()`) : le
 * service temps réel met hors ligne un chauffeur resté déconnecté au-delà de la période de grâce.
 */
export async function signOutDriver(): Promise<DriverSignOutOutcome> {
  if (locationTracker.getState() !== 'offline') {
    try {
      const response = (await apiClient.request('setAvailability', {
        body: { online: false },
      })) as http.SetAvailabilityResponse;
      realtimeClient.send('availability.set', { online: response.online });
      locationTracker.setOnline(response.online);
    } catch (error) {
      if (error instanceof ApiError) return { signedOut: false, message: translateApiError(error) };
    }
  }
  await signOut();
  return { signedOut: true };
}
