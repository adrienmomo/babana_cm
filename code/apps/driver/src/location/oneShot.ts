import Geolocation from '@react-native-community/geolocation';
import { ensureForegroundPermission } from './permissions';

/**
 * Position ponctuelle du chauffeur, à la demande (L6-13). Anciennement `apps/driver/src/location.ts`
 * (déplacé ici quand L6-05 a introduit le dossier `location/`, permissions désormais partagées
 * avec la capture continue via `./permissions.ts` plutôt que deux implémentations séparées).
 *
 * **Une lecture unique, pas une capture continue** -- voir `./tracker.ts` pour la capture GPS
 * continue (fréquence adaptative, agrégation, arrière-plan). Ce module ne fournit qu'un relevé à
 * l'instant, pour le seul besoin qui ne peut pas attendre : le bouton d'urgence (L8-04), qui doit
 * joindre une position à son alerte. Le choix « rappeler le GPS maintenant » plutôt que
 * « réutiliser la dernière position connue de `tracker.ts` » reste délibéré : au moment d'une
 * urgence, la position la plus fraîche possible vaut mieux qu'une position vieille de plusieurs
 * dizaines de secondes issue d'une cadence ralentie pour la batterie.
 *
 * Ne rejette jamais : `null` si la permission est refusée ou le GPS indisponible -- l'appelant
 * (EmergencyButton) affiche alors « Position indisponible », jamais une position inventée.
 */
export async function getCurrentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  const allowed = await ensureForegroundPermission();
  if (allowed !== 'granted') return null;

  return new Promise((resolve) => {
    Geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}
