/**
 * Constructeur de la clé de réservation d'un chauffeur (L3-06). Module sans dépendance, séparé de
 * `reserve.ts` -- même raison que `driver/keys.ts` : `redis/pool-eligibility.ts` a besoin de cette
 * clé sans avoir besoin de la logique de réservation elle-même (reserveDriver, releaseDriver, le
 * veilleur d'expiration), qui elle importe `redis/pool-eligibility.ts`. Les deux dans un seul
 * fichier fermeraient un cycle.
 */

// Exporté (pas seulement local) : reserve.ts en a besoin pour reconnaître une clé de réservation
// expirée dans le flux d'événements keyspace de Redis (startReservationExpiryWatcher), qui ne
// porte que la clé complète, jamais le driverId isolé.
export const RESERVATION_KEY_PREFIX = 'babana:driver:reservation:';

export function reservationKey(driverId: string): string {
  return `${RESERVATION_KEY_PREFIX}${driverId}`;
}
