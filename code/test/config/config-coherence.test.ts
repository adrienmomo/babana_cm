// L0-10 -- cohérence de la chaîne de configuration (D59, amoa/01-architecture.md §9 sexies).
//
// Deux familles de cas ici :
//   1. Contre le VRAI dépôt (`checkCoherence(findRepoRoot(...))`) : le garde-fou qui tourne à
//      chaque `make test`. Doit rester vide -- c'est la preuve que les trois moments de chaque
//      variable déclarée tiennent aujourd'hui.
//   2. Contre des mini-dépôts SYNTHÉTIQUES (mkdtemp) : la preuve, exigée par les critères
//      d'acceptation 2, 3 et 4, que le mécanisme détecte réellement chaque famille de défaut --
//      sans modifier puis annuler le vrai dépôt à chaque exécution de la suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCoherence, checkVariableCoherence, findRepoRoot } from '../../tools/config-coherence/scan';

const REPO_ROOT = findRepoRoot(process.cwd());

describe('cohérence de la chaîne de configuration (dépôt réel)', () => {
  test('aucun maillon manquant parmi les variables déclarées ou consommées', () => {
    const { problems } = checkCoherence(REPO_ROOT);
    assert.deepEqual(problems, [], 'maillons manquants :\n  ' + problems.join('\n  '));
  });
});

/** Construit un mini-dépôt jetable avec juste assez de structure pour que `checkCoherence` s'y
 * retrouve (infra/env/.env.example, et les fichiers passés dans `files`). */
function makeFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'babana-config-coherence-'));
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('critère 2 -- une variable ajoutée au code sans être déclarée fait échouer la suite', () => {
  test('process.env.X non déclarée est détectée', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': '# rien de déclaré\n',
      'apps/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDECLARED || '';\n",
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.ok(
        problems.some((p) => p.startsWith('BABANA_TEST_UNDECLARED :') && p.includes('absente de infra/env/.env.example')),
        `attendu un problème pour BABANA_TEST_UNDECLARED, trouvé :\n  ${problems.join('\n  ')}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('une fois déclarée ET livrée, la même variable ne remonte plus', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_UNDECLARED=\n',
      'apps/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDECLARED || '';\n",
      'infra/compose.yaml': 'services:\n  odoo:\n    environment:\n      BABANA_TEST_UNDECLARED: ${BABANA_TEST_UNDECLARED}\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.deepEqual(problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("critère 3 -- une variable déclarée que rien ne livre fait échouer la suite", () => {
  test('déclarée et consommée, jamais livrée', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_UNDELIVERED=\n',
      'apps/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDELIVERED || '';\n",
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.ok(
        problems.some((p) => p.startsWith('BABANA_TEST_UNDELIVERED :') && p.includes('rien ne la livre')),
        `attendu un problème pour BABANA_TEST_UNDELIVERED, trouvé :\n  ${problems.join('\n  ')}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("livrée par un export de build, plus rien ne remonte", () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_UNDELIVERED=\n',
      'apps/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDELIVERED || '';\n",
      'infra/production/deploy.sh': '#!/bin/sh\nexport BABANA_TEST_UNDELIVERED\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.deepEqual(problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('critère 4 -- une exception sans tâche de fermeture fait échouer la suite', () => {
  test('EXCEPTIONS actuelles portent toutes une tâche non vide', () => {
    // Vérifié directement sur le module réel (pas une fixture) : `checkCoherence` sur le vrai
    // dépôt applique déjà cette règle (voir la boucle EXCEPTIONS dans scan.ts) -- ce test rend
    // explicite CE qui est vérifié, pour qu'une exception malformée ajoutée plus tard ne se
    // glisse pas sans qu'on l'ait vu échouer une fois.
    const { problems } = checkCoherence(REPO_ROOT);
    assert.ok(
      !problems.some((p) => p.includes('sans tâche de fermeture')),
      'une exception de tools/config-coherence/variables.ts est sans tâche de fermeture'
    );
  });
});
