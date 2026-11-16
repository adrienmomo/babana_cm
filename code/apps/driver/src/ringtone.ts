import { NativeModules } from 'react-native';

/**
 * Sonnerie d'une proposition (15 novembre) : le mp3 fourni par le maître d'ouvrage
 * (`android/app/src/main/res/raw/proposal_ringtone.mp3` -- un son provisoire en attendant), en
 * boucle, au volume des alarmes, jusqu'à la réponse ou l'expiration. Android seulement : ailleurs
 * (iOS, tests) rien ne sonne, sans erreur.
 */
interface RingtoneNativeModule {
  start(maxDurationMs: number): void;
  stop(): void;
}

function native(): RingtoneNativeModule | undefined {
  return (NativeModules as { BabanaRingtone?: RingtoneNativeModule }).BabanaRingtone;
}

/** Sans échéance connue : au plus ce temps (une proposition expire en 30 s par défaut). */
export const RINGTONE_DEFAULT_MAX_MS = 45_000;
const RINGTONE_MIN_MS = 5_000;
const RINGTONE_MAX_MS = 60_000;

/** Durée de sonnerie jusqu'à l'échéance de la proposition, bornée (une horloge de téléphone dérive). */
export function ringDurationMs(expiresAt: string | null | undefined, nowMs: number = Date.now()): number {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(at)) return RINGTONE_DEFAULT_MAX_MS;
  return Math.min(RINGTONE_MAX_MS, Math.max(RINGTONE_MIN_MS, at - nowMs));
}

export function startProposalRingtone(expiresAt?: string | null): void {
  native()?.start(ringDurationMs(expiresAt));
}

export function stopProposalRingtone(): void {
  native()?.stop();
}
