/**
 * Écran allumé, export web (décision du 14 novembre) -- Screen Wake Lock API. Le navigateur
 * relâche le verrou dès que l'onglet est masqué : il est redemandé à son retour, tant que l'écran
 * carte le veut encore. Navigateur sans cette API : sans effet.
 */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;

function wakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock ?? null;
}

function acquire(): void {
  const api = wakeLock();
  if (!api || sentinel || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  api.request('screen').then(
    (lock) => {
      if (wanted) sentinel = lock;
      else lock.release().catch(() => undefined);
    },
    () => undefined // refusé (économie d'énergie, onglet en arrière-plan) : on réessaiera au retour
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sentinel = null; // relâché par le navigateur pendant que l'onglet était masqué
      if (wanted) acquire();
    }
  });
}

export function setScreenAwake(on: boolean): void {
  wanted = on;
  if (on) {
    acquire();
  } else if (sentinel) {
    const lock = sentinel;
    sentinel = null;
    lock.release().catch(() => undefined);
  }
}
