import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Invariant 1, garantie mécanique (amoa/04-monorepo-et-services.md §8) : le service temps réel
 * ne possède aucune donnée durable, donc aucune dépendance à un client PostgreSQL. Critère
 * d'acceptation 4 de L0-04.
 */
const FORBIDDEN_POSTGRES_CLIENTS = ['pg', 'pg-promise', 'postgres', 'sequelize', 'typeorm', 'prisma', 'knex', 'slonik'];

test('package.json ne dépend d\'aucun client PostgreSQL', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const found = FORBIDDEN_POSTGRES_CLIENTS.filter((name) => name in allDeps);
  assert.deepEqual(found, [], `client(s) PostgreSQL interdits trouvés dans package.json : ${found.join(', ')}`);
});
