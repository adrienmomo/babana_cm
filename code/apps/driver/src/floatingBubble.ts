import { AppState, NativeModules, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { locationTracker } from './location';

/**
 * Icône flottante du chauffeur en ligne (15 novembre, point 9) : app en arrière-plan et chauffeur
 * en ligne, une bulle à l'icône de l'app reste par-dessus les autres apps -- un appui la rouvre.
 * Une proposition reçue app cachée ramène l'app au premier plan (réponse du maître d'ouvrage).
 * Android seulement, et seulement si le chauffeur a accordé « Afficher par-dessus les autres
 * applis » : sans elle, rien ne s'affiche, la sonnerie et la notification restent.
 */
interface BubbleNativeModule {
  canDrawOverlays(): Promise<boolean>;
  openPermissionSettings(): void;
  show(): void;
  hide(): void;
  bringToFront(): void;
}

function native(): BubbleNativeModule | undefined {
  return (NativeModules as { BabanaFloatingBubble?: BubbleNativeModule }).BabanaFloatingBubble;
}

/** La bulle se montre exactement quand le chauffeur est en ligne et que l'app n'est pas à l'écran. */
export function shouldShowBubble(appState: AppStateStatus, online: boolean): boolean {
  return online && appState !== 'active';
}

let started = false;

/** Point d'accroche unique (`bootstrap.ts`). Idempotent. */
export function startFloatingBubble(): void {
  if (started) return;
  started = true;
  let appState: AppStateStatus = AppState.currentState ?? 'active';
  let online = locationTracker.isOnline();
  const apply = () => {
    if (shouldShowBubble(appState, online)) native()?.show();
    else native()?.hide();
  };
  AppState.addEventListener('change', (next) => {
    appState = next;
    apply();
  });
  locationTracker.subscribeOnline((next) => {
    online = next;
    apply();
  });
}

/** Proposition reçue app cachée : l'app revient au premier plan, sur la proposition. */
export function bringAppToFront(): void {
  if (AppState.currentState === 'active') return;
  native()?.bringToFront();
}

const OVERLAY_ASKED_KEY = 'babana.driver.overlayPermissionAsked';

/**
 * Demandée une fois, au premier passage en ligne réussi : les réglages Android s'ouvrent sur
 * l'autorisation. Jamais redemandée ensuite (le chauffeur l'a vue ; il peut l'accorder plus tard).
 */
export async function askOverlayPermissionOnce(): Promise<void> {
  const bubble = native();
  if (!bubble) return;
  try {
    if (await bubble.canDrawOverlays()) return;
    if ((await AsyncStorage.getItem(OVERLAY_ASKED_KEY)) === '1') return;
    await AsyncStorage.setItem(OVERLAY_ASKED_KEY, '1');
    bubble.openPermissionSettings();
  } catch {
    // Sans stockage ou sans module : pas de bulle, rien d'autre ne change.
  }
}
