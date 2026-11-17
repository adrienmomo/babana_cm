import { reverseGeocode, type LatLng } from '@babana/maps';

// Doute L6-06 §1 (amoa/questions/REPONSES-2026-08-23.md §2) : hors des grands axes, le géocodage
// inverse ne répond jamais "je ne sais pas" -- il rend le repère connu le plus proche, qui peut
// être à plusieurs centaines de mètres du réticule. Le libellé se présente donc sous une forme
// qui dit son approximation plutôt que le nom seul ; l'interface rappelle par ailleurs (JSX
// ci-dessous) que c'est le point sur la carte qui fait foi, pas le texte.
export async function labelFor(position: LatLng): Promise<string> {
  // L'échec du géocodage inverse (Odoo/Google indisponible) ne doit jamais empêcher de désigner
  // un point -- les coordonnées elles-mêmes restent la vérité, seul le libellé se dégrade.
  const label = await reverseGeocode(position).catch(() => null);
  // Seul le premier segment de l'adresse (« Carrefour Tiff », pas « Carrefour Tiff, Douala,
  // Cameroun ») : la ville est implicite, et le champ est étroit.
  const landmark = label?.split(',')[0]?.trim();
  return landmark ? `vers ${landmark}` : `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`;
}
