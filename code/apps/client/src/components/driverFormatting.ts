import type { http } from '@babana/contracts';

/**
 * Mise en forme du chauffeur affecté (TrackingScreen). Le client ne voit plus de liste de
 * chauffeurs à choisir : avant l'affectation, les chauffeurs proches ne sont que des points.
 */

export const GENERIC_AVATAR = 'https://storage.babana.cm/static/driver-avatar-generic.png';

export function classLabel(motorcycleClass: http.NearbyDriver['motorcycleClass']): string | null {
  if (motorcycleClass === null) return null;
  return motorcycleClass === 'premium' ? 'Confort' : 'Standard';
}
