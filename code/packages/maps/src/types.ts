import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { http } from '@babana/contracts';

/**
 * Interface publique du paquet (L6-01, C3). Aucun type du SDK de carte (react-native-maps,
 * Google Maps) n'apparaît ici -- seuls des types propres à @babana/maps, ou hérités de
 * @babana/contracts (D17, jamais redéclarés) et de react-native lui-même (StyleProp/ViewStyle ne
 * sont pas le SDK de carte, seulement le système de style de la plateforme). Vérifié
 * mécaniquement : `packages/maps/src/**` (hors `providers/`) ne peut pas importer les paquets de
 * carte listés dans `.eslintrc.cjs` (critère d'acceptation 1 et 2).
 */

export type LatLng = http.LatLng;

/**
 * Type de marqueur, pas un style -- l'apparence (icône, couleur) est une décision du fournisseur
 * (`providers/google/MapView.tsx`), jamais de l'écran appelant.
 */
export type MapMarkerKind = 'client' | 'driver' | 'pickup' | 'dropoff' | 'reticle';

export interface MapMarker {
  id: string;
  kind: MapMarkerKind;
  position: LatLng;
  label?: string;
}

/** Tracé affiché sur la carte (suivi de course, résumé de course -- L6-09). */
export interface MapRoute {
  points: LatLng[];
}

export interface MapViewProps {
  /** Carte centrée sur ce point (L6-06 : position du client par défaut). */
  center: LatLng;
  markers?: MapMarker[];
  route?: MapRoute;
  /**
   * Déplacement de la carte sous un réticule fixe (L6-06, premier des deux moyens de
   * désignation, prioritaire sur la recherche textuelle -- l'adresse formelle n'existe quasiment
   * pas à Douala).
   */
  onRegionChange?: (center: LatLng) => void;
  style?: StyleProp<ViewStyle>;
}

export interface PlaceResult {
  label: string;
  position: LatLng;
}

export interface NavigationOptions {
  /** Libellé affiché par l'app de navigation externe, quand elle le supporte. */
  label?: string;
  /**
   * Rappelé quand le guidage est terminé. En v1 (lien profond, D12), approximé par le retour au
   * premier plan de l'app après l'avoir quittée pour Google Maps -- en v2 (SDK embarqué), ce
   * sera un rapport d'arrivée réel. Signature identique dans les deux cas (critère d'acceptation
   * 3) : aucun écran n'aura à changer pour accueillir la v2.
   */
  onComplete?: () => void;
}

/**
 * Contrat qu'un fournisseur doit satisfaire en entier. `providers/google` (réel, v1) et
 * `providers/empty` (vide, critère d'acceptation 5) l'implémentent tous deux -- la preuve que
 * l'abstraction accueille plus d'un fournisseur est qu'`empty` compile sans jamais importer le
 * SDK. `providers/web` (L6-18) l'implémentera à son tour sans qu'aucun écran ne change (critère
 * d'acceptation 6).
 */
export interface MapProvider {
  MapView: ComponentType<MapViewProps>;
  openNavigation(destination: LatLng, options?: NavigationOptions): void;
  searchPlace(query: string): Promise<PlaceResult[]>;
  reverseGeocode(point: LatLng): Promise<string | null>;
}
