import type { http } from '@babana/contracts';
import { apiClient } from './auth';
import type { RidePoint } from './navigation/types';

/** Nombre de destinations récentes proposées sur l'accueil -- une rangée de raccourcis, pas une liste. */
export const RECENT_DESTINATIONS_COUNT = 3;

/**
 * Destinations récentes (accueil) : les arrivées distinctes des dernières courses, tirées de la
 * première page de l'historique (GET /rides) -- aucune donnée propre au téléphone, aucune
 * dépendance de stockage. Désigner une adresse est l'étape la plus difficile à Douala ; refaire
 * un trajet habituel tient alors en un geste.
 *
 * Une course sans libellé d'arrivée (commandée avant le 30 octobre) est ignorée : un raccourci
 * qu'on ne peut pas nommer n'aide personne.
 */
export function pickRecentDestinations(rides: readonly http.RideHistoryEntry[]): RidePoint[] {
  const seen = new Set<string>();
  const points: RidePoint[] = [];
  for (const ride of rides) {
    const label = ride.dropoffLabel?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    points.push({ position: ride.dropoff, label });
    if (points.length === RECENT_DESTINATIONS_COUNT) break;
  }
  return points;
}

export async function fetchRecentDestinations(): Promise<RidePoint[]> {
  const page = (await apiClient.request('rideHistory', { query: {} })) as http.RideHistoryResponse;
  return pickRecentDestinations(page.rides);
}
