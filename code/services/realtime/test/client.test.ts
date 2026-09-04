// D71 (amoa/01-architecture.md §9 terdecies) : `callOdoo` et `callOdooOnce` n'avaient aucun
// délai -- les deux seuls appels sortants du service dans ce cas. Contre un vrai serveur HTTP
// local qui accepte la connexion et ne répond JAMAIS (pas un serveur qui répond une erreur --
// c'est déjà couvert ailleurs, et ce n'est pas ce que produisait le défaut) : la seule façon de
// distinguer "Odoo se tait" de "Odoo refuse vite" est de ne jamais appeler res.end().
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ServerResponse } from 'node:http';
import { callOdoo, callOdooOnce } from '../src/odoo/client';
import { parseConfig, type Config } from '../src/config';

let server: http.Server;
let port: number;
let mode: 'silent' | 'ok' = 'silent';
const pendingResponses: ServerResponse[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (mode === 'silent') {
        // Ne répond jamais -- la connexion reste ouverte tant que rien ne l'abandonne. Gardée
        // pour un nettoyage explicite plutôt que de laisser le processus de test la porter.
        pendingResponses.push(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
  port = address.port;
});

beforeEach(() => {
  mode = 'silent';
});

after(async () => {
  for (const res of pendingResponses.splice(0)) {
    res.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({
    REDIS_URL: 'redis://unused:6379',
    ODOO_INTERNAL_URL: `http://127.0.0.1:${port}`,
    REALTIME_SHARED_SECRET: 'secret',
    JWT_SECRET: 'secret',
    ...overrides,
  });
}

describe('callOdoo -- délai par tentative (D71)', () => {
  test('un Odoo qui se tait finit par échouer, pas par attendre indéfiniment', async () => {
    const config = configWith({ ODOO_CALL_TIMEOUT_MS: '100' });
    const before2 = Date.now();
    await assert.rejects(() => callOdoo(config, '/whatever', {}, { retries: 0 }));
    const elapsed = Date.now() - before2;
    // Une seule tentative (retries: 0), bornée par ODOO_CALL_TIMEOUT_MS -- large marge au-dessus
    // (500 ms) pour ne pas rendre le test instable sous charge, très en-dessous de "indéfiniment".
    assert.ok(elapsed < 500, `callOdoo doit échouer près du délai configuré, pas y rester bloqué (${elapsed} ms)`);
  });

  test('le temps total du réessai (3 tentatives par défaut) reste borné et prévisible', async () => {
    const config = configWith({ ODOO_CALL_TIMEOUT_MS: '100' });
    const before2 = Date.now();
    // Défauts de callOdoo : retries=3, baseDelayMs=200 -- 4 tentatives à 100 ms chacune (400 ms)
    // plus les délais croissants entre elles (200+400+800 = 1400 ms) = ~1800 ms au pire.
    await assert.rejects(() => callOdoo(config, '/whatever', {}));
    const elapsed = Date.now() - before2;
    assert.ok(elapsed < 3_000, `le réessai complet doit rester borné, pas y compris un silence (${elapsed} ms)`);
  });

  test('n\'échoue pas si Odoo répond avant le délai', async () => {
    mode = 'ok';
    const config = configWith({ ODOO_CALL_TIMEOUT_MS: '2000' });
    const result = await callOdoo(config, '/whatever', {});
    assert.deepEqual(result, { ok: true });
  });
});

describe('callOdooOnce -- délai d\'une tentative unique (D71)', () => {
  test('un Odoo qui se tait lève une erreur réseau, exactement ce que le commentaire promettait déjà', async () => {
    const config = configWith({ ODOO_CALL_TIMEOUT_MS: '100' });
    const before2 = Date.now();
    await assert.rejects(() => callOdooOnce(config, '/whatever', {}));
    const elapsed = Date.now() - before2;
    assert.ok(elapsed < 500, `callOdooOnce doit lever près du délai configuré (${elapsed} ms)`);
  });

  test('renvoie normalement si Odoo répond avant le délai', async () => {
    mode = 'ok';
    const config = configWith({ ODOO_CALL_TIMEOUT_MS: '2000' });
    const result = await callOdooOnce(config, '/whatever', {});
    assert.equal(result.ok, true);
  });
});
