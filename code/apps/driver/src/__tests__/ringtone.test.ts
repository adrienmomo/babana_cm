import { NativeModules } from 'react-native';

// 15 novembre : la sonnerie d'une proposition boucle jusqu'à la réponse ou l'expiration -- l'arrêt
// automatique est natif, borné : un téléphone dans une poche ne sonne jamais sans fin.

const start = jest.fn();
const stop = jest.fn();
(NativeModules as Record<string, unknown>).BabanaRingtone = { start, stop };

import { RINGTONE_DEFAULT_MAX_MS, ringDurationMs, startProposalRingtone, stopProposalRingtone } from '../ringtone';

const NOW = Date.parse('2026-11-15T12:00:00Z');

test('jusqu’à l’échéance de la proposition', () => {
  expect(ringDurationMs('2026-11-15T12:00:25Z', NOW)).toBe(25_000);
});

test('bornée : jamais moins de 5 s, jamais plus de 60 s (une horloge de téléphone dérive)', () => {
  expect(ringDurationMs('2026-11-15T11:59:00Z', NOW)).toBe(5_000);
  expect(ringDurationMs('2026-11-15T12:30:00Z', NOW)).toBe(60_000);
});

test('sans échéance connue : la durée par défaut', () => {
  expect(ringDurationMs(null, NOW)).toBe(RINGTONE_DEFAULT_MAX_MS);
  expect(ringDurationMs('pas une date', NOW)).toBe(RINGTONE_DEFAULT_MAX_MS);
});

test('démarre et s’arrête par le module natif', () => {
  startProposalRingtone(null);
  expect(start).toHaveBeenCalledWith(RINGTONE_DEFAULT_MAX_MS);
  stopProposalRingtone();
  expect(stop).toHaveBeenCalledTimes(1);
});
