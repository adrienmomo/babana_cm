import { openNavigation, type LatLng } from '@babana/maps';

/**
 * Lancement du guidage pendant une course en cours (L6-13, D12). Deux phases : approche vers le
 * client, puis trajet vers la destination -- le point visé change, pas la façon de l'ouvrir.
 *
 * Passe par `@babana/maps` (L6-01), jamais un SDK de carte en direct : `openNavigation` construit
 * un lien profond Google Maps en v1 et ouvrira un SDK embarqué en v2, avec la même signature --
 * aucun écran ne changera (critère d'acceptation 3 de L6-01). L'app reste vivante derrière
 * (Google Maps s'ouvre par-dessus) ; `onReturn` est appelé quand elle revient au premier plan.
 */

export type RidePhase = 'approach' | 'transit';

export function launchRideNavigation(
  phase: RidePhase,
  points: { origin: LatLng; destination: LatLng },
  onReturn?: () => void
): void {
  const target = phase === 'approach' ? points.origin : points.destination;
  const label = phase === 'approach' ? 'Point de prise en charge' : 'Destination de la course';
  openNavigation(target, { label, onComplete: onReturn });
}
