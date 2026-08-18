import type { LatLng } from '@babana/maps';

/**
 * Résultat de `getCurrentPosition` (L6-06, doute §2 -- amoa/questions/REPONSES-2026-08-23.md
 * §2). Les trois causes d'échec appellent des réactions opposées : un refus de permission se
 * règle dans les réglages du téléphone, une position indisponible se règle en sortant d'un
 * bâtiment, un délai dépassé se règle en réessayant. Les confondre dans un simple `null` prive
 * l'utilisateur de la seule information qui lui servirait -- quoi faire. Type partagé entre
 * `location.ts` (natif) et `location.web.ts` (D22) : les deux mappent les codes d'erreur
 * `GeolocationPositionError` du même standard (1 = permission, 2 = position, 3 = délai), un seul
 * endroit déclare la forme du résultat plutôt que deux qui pourraient diverger.
 */
export type LocationFailureReason = 'permission-denied' | 'position-unavailable' | 'timeout';

export type LocationResult =
  | { status: 'success'; position: LatLng }
  | { status: 'error'; reason: LocationFailureReason };

/** Codes `GeolocationPositionError` du standard W3C, repris tels quels par
 * `@react-native-community/geolocation` et par `navigator.geolocation` -- une seule table de
 * correspondance pour les deux plateformes. */
export function mapGeolocationErrorCode(code: number | undefined): LocationFailureReason {
  switch (code) {
    case 1:
      return 'permission-denied';
    case 3:
      return 'timeout';
    default:
      return 'position-unavailable';
  }
}
