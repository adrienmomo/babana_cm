import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TEST_REDIS_URL } from './helpers/redis';

// Le service en marche pendant `make test` (infra/compose.yaml) et ces tests partagent le serveur
// Redis ; ils ne doivent jamais partager la base (test/helpers/redis.ts).
const dbOf = (url: string) => Number(new URL(url).pathname.slice(1) || '0');

test('les tests unitaires utilisent une autre base Redis que le service temps réel en marche', () => {
  const compose = readFileSync(join(__dirname, '..', '..', '..', 'infra', 'compose.yaml'), 'utf8');
  const serviceUrl = /REDIS_URL:\s*(\S+)/.exec(compose)?.[1];
  assert.ok(serviceUrl, 'REDIS_URL du service introuvable dans infra/compose.yaml');
  assert.notEqual(dbOf(TEST_REDIS_URL), dbOf(serviceUrl));
});
