import type { realtime } from '@babana/contracts';

/**
 * Mise en forme du chauffeur affecté (TrackingScreen). Le client ne voit plus de liste de
 * chauffeurs à choisir : avant l'affectation, les chauffeurs proches ne sont que des points.
 */

/** « Emmanuel Ndoumbè » : prénom et nom (15 novembre) ; à défaut, ce qui est connu. */
export function driverDisplayName(driver: { firstName: string | null; lastName?: string | null }): string {
  return [driver.firstName, driver.lastName].filter((part): part is string => Boolean(part)).join(' ') || 'Votre chauffeur';
}

export function classLabel(motorcycleClass: realtime.RideAssignedMessage['payload']['motorcycleClass']): string | null {
  if (motorcycleClass === null) return null;
  return motorcycleClass === 'premium' ? 'Confort' : 'Standard';
}
