// Un chauffeur en ligne qui attend sans bouger ne doit jamais sortir du pool : le service temps
// réel oublie une position au bout de POSITION_TTL_SECONDS, l'application Chauffeur n'en renvoie
// une qu'à chaque relevé immobile (LOCATION_CAPTURE_INTERVAL_IDLE_MS). Deux valeurs par défaut,
// deux fichiers, aucun mécanisme pour les tenir d'accord -- d'où ce test. Constaté le 22 octobre
// sur émulateur : relevé immobile à 90 s pour une durée de vie de 60 s, le chauffeur était absent
// du pool plus d'une minute sur deux, et la course partait sans lui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

function defaultOf(path: string, pattern: RegExp): number {
  const match = readFileSync(join(root, path), 'utf8').match(pattern);
  assert.ok(match, `valeur par défaut introuvable dans ${path}`);
  return Number(match[1]!.replace(/_/g, ''));
}

test('le relevé immobile du chauffeur part au moins deux fois par durée de vie d’une position', () => {
  const idleMs = defaultOf('apps/driver/config.ts', /LOCATION_CAPTURE_INTERVAL_IDLE_MS = .*\|\| ([\d_]+);/);
  const ttlSeconds = defaultOf('services/realtime/src/config.ts', /POSITION_TTL_SECONDS: .*\.default\(([\d_]+)\)/);

  assert.ok(
    idleMs * 2 <= ttlSeconds * 1000,
    `relevé immobile ${idleMs} ms pour une durée de vie de ${ttlSeconds} s : un seul relevé perdu fait sortir le chauffeur du pool`
  );
});
