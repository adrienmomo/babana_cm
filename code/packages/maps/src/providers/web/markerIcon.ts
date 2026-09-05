import type { MapMarkerKind } from '../../types';

/**
 * Même couleur par catégorie que `providers/google/MapView.tsx` -- extrait ici (au lieu de
 * dupliquer un `switch` de plus) pour rester testable sans charger `react-native-maps` ni le
 * moindre SDK web (critère d'acceptation 4, L6-01).
 */
export function colorFor(kind: MapMarkerKind): string {
  switch (kind) {
    case 'driver':
      return '#0A7D3D';
    case 'client':
      return '#1D4ED8';
    case 'pickup':
      return '#0A7D3D';
    case 'dropoff':
      return '#B91C1C';
    case 'reticle':
      return '#6B7280';
  }
}

/**
 * Icône SVG en donnée-URI, colorée par catégorie -- pas d'image statique à empaqueter, et pas de
 * dépendance à `google.maps.SymbolPath` (dont le rendu diffère trop de la couleur pleine du
 * fournisseur natif pour rester une "même interface" convaincante).
 */
export function markerIconUrl(kind: MapMarkerKind): string {
  const color = colorFor(kind);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22">` +
    `<circle cx="11" cy="11" r="8" fill="${color}" stroke="#ffffff" stroke-width="2"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
