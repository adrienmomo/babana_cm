import type { LatLng, NavigationOptions } from '../../types';

/**
 * Même lien profond que le fournisseur natif (`providers/google/navigation.ts`, D12) -- un
 * nouvel onglet plutôt qu'un `Linking.openURL` (React Native Web ne l'implémente pas vers une
 * origine externe de la même façon), avec `noopener,noreferrer` (l'onglet ouvert ne doit pas
 * pouvoir agir sur celui qui l'a ouvert).
 */
function buildGoogleMapsUrl(destination: LatLng): string {
  return (
    'https://www.google.com/maps/dir/?api=1' +
    `&destination=${destination.latitude},${destination.longitude}` +
    '&travelmode=driving'
  );
}

/**
 * `onComplete` n'est jamais rappelé ici -- dégradation signalée (spécification L6-18, "lien
 * profond de navigation") plutôt que masquée : un navigateur n'offre aucun équivalent fiable à
 * `AppState` (fournisseur natif) pour détecter un retour sur cet onglet après avoir quitté vers
 * un autre. Deviner via `visibilitychange` produirait des faux positifs (changer d'onglet pour
 * autre chose compterait comme "revenu de la navigation") -- pire qu'une absence assumée.
 */
export function openNavigation(destination: LatLng, _options: NavigationOptions = {}): void {
  if (typeof window === 'undefined') return;
  window.open(buildGoogleMapsUrl(destination), '_blank', 'noopener,noreferrer');
}
