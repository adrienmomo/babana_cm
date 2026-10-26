import type { MapMarkerKind } from './types';

/**
 * Une couleur par rôle de repère, jamais deux rôles de la même couleur : le chauffeur (vert de
 * l'app), le point de prise en charge (bleu, comme le tracé qui y mène), l'arrivée (rouge adouci).
 *
 * Exportée pour les écrans qui dessinent eux-mêmes un repère par-dessus la carte -- le réticule de
 * désignation de l'accueil Client prend la couleur du point qu'il désigne : une seule palette,
 * jamais une copie locale qui divergerait.
 */
export const MAP_MARKER_COLORS: Readonly<Record<MapMarkerKind, string>> = {
  driver: '#1A9E5C',
  client: '#3E7BFA',
  pickup: '#3E7BFA',
  dropoff: '#E5484D',
  reticle: '#6B7280',
};
