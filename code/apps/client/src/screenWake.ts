import { NativeModules } from 'react-native';

/**
 * Écran allumé, côté natif (décision du 14 novembre) -- `android/.../keepawake/KeepAwakeModule.kt`.
 * Équivalent web : `screenWake.web.ts`. Module absent (iOS, tests) : sans effet, l'écran s'éteint
 * comme d'habitude plutôt que de faire échouer l'écran qui le demande.
 */
interface KeepAwakeModule {
  activate(): void;
  deactivate(): void;
}

const native = (NativeModules as { BabanaKeepAwake?: KeepAwakeModule }).BabanaKeepAwake;

export function setScreenAwake(on: boolean): void {
  if (!native) return;
  if (on) native.activate();
  else native.deactivate();
}
