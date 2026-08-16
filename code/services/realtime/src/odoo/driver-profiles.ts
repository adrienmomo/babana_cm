import type { Config } from '../config';
import { callOdoo } from './client';
import type { DriverProfile } from '../redis/driver-profiles';

/**
 * Sens temps réel -> Odoo (L3-16) : lit par lot les quatre champs de profil chauffeur affichés
 * par `nearby.drivers` (services/odoo/addons/babana/controllers/internal_profiles.py, liste
 * blanche appliquée côté Odoo). Bloquant pour son appelant (`redis/driver-profiles.ts`), même
 * raisonnement que `fetchEngagedDriverIds` (odoo/rides.ts) : l'appelant a besoin du résultat pour
 * décider quoi mettre en cache, pas d'un effet de bord à ne pas attendre.
 *
 * `retries: 1` plutôt que le défaut de `callOdoo` (3, jusqu'à ~1.4 s d'essais) : cet appel peut
 * survenir en plein calcul d'une diffusion `nearby.drivers` (toutes les
 * NEARBY_BROADCAST_INTERVAL_SECONDS) -- une latence trop longue ici retarderait la diffusion pour
 * un bénéfice qui n'est pas prioritaire (critère 2 : Odoo injoignable dégrade, ne bloque pas).
 */
export async function fetchDriverProfiles(
  config: Config,
  driverIds: string[]
): Promise<Record<string, DriverProfile>> {
  if (driverIds.length === 0) return {};
  const result = await callOdoo(
    config,
    '/api/internal/drivers/profiles',
    { driverIds },
    { retries: 1, baseDelayMs: 100 }
  );
  const body = result as { profiles?: Record<string, DriverProfile> };
  return body.profiles ?? {};
}
