// D43 retournée (amoa/questions/REPONSES-2026-09-06.md §2, amoa/01-architecture.md §9 ter) :
// `infra/env/.env.example` est recopié en `infra/env/.env` par `make up`, et c'est aussi le
// point de départ documenté d'un `.env` de production. Une adresse de fournisseur externe qui y
// figure avec la valeur d'un simulateur est un piège : une mise en production qui suit le chemin
// documenté enverrait ses appels au simulateur. `SMTP_HOST=mailpit` était le cas le plus grave
// -- mailpit accepte une facture et ne signale rien.
//
// Ce test rend la règle mécanique : les variables qui désignent un fournisseur externe DOIVENT
// être vides dans `.env.example`, et le fichier ne doit contenir aucun nom d'hôte de simulateur.
// La valeur de développement vit ailleurs (infra/compose.dev.yaml pour ce qu'Odoo consomme, les
// cibles `make client` pour ce qui est lu au build) -- vérifié par les autres suites et par
// `make up` lui-même.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `npm test -w @babana/concurrency-tests` lance ce fichier avec le cwd fixé à `code/test/`.
 * On remonte jusqu'à trouver `infra/env/.env.example` -- tolère aussi un lancement depuis
 * `code/`. */
function locateEnvExample(): string {
  for (const rel of ['../infra/env/.env.example', 'infra/env/.env.example', '../../infra/env/.env.example']) {
    const candidate = resolve(process.cwd(), rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`infra/env/.env.example introuvable depuis ${process.cwd()}`);
}

const ENV_EXAMPLE = locateEnvExample();

/** Variables dont la valeur désigne un fournisseur externe réel (ou son simulateur) : pas de
 * valeur par défaut dans `.env.example`. */
const MUST_BE_EMPTY = [
  'GOOGLE_JWKS_URL',
  'GOOGLE_ROUTING_URL',
  'BABANA_MAPS_SEARCH_URL',
  'SMTP_HOST',
  'SMTP_PORT',
];

/** Marqueurs d'un hôte de simulateur / de développement qui n'ont rien à faire dans le fichier
 * d'exemple, quelle que soit la variable. */
const SIMULATOR_MARKERS = ['mailpit', 'mock-google-identity', 'mock-maps', ':4000', ':4001'];

function parseEnv(contents: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

describe('infra/env/.env.example', () => {
  const contents = readFileSync(ENV_EXAMPLE, 'utf8');
  const vars = parseEnv(contents);

  for (const name of MUST_BE_EMPTY) {
    test(`${name} n'a pas de valeur (D43 : renseignée ailleurs pour le dev)`, () => {
      assert.ok(vars.has(name), `${name} devrait être déclarée (vide) dans .env.example`);
      assert.equal(
        vars.get(name),
        '',
        `${name} désigne un fournisseur externe -- vide dans .env.example, valeur de dev dans ` +
          `infra/compose.dev.yaml ou les cibles Makefile. Une valeur ici serait recopiée en prod.`
      );
    });
  }

  test('aucune ligne de valeur ne contient un nom d\'hôte de simulateur', () => {
    const offenders: string[] = [];
    for (const [name, value] of vars) {
      for (const marker of SIMULATOR_MARKERS) {
        if (value.includes(marker)) offenders.push(`${name}=${value} (contient "${marker}")`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'valeurs pointant vers un simulateur dans .env.example :\n  ' + offenders.join('\n  ')
    );
  });
});
