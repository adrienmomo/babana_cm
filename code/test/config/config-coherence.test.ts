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
  // 'services/fixture/' délibérément, pas 'apps/fixture/' ou 'services/odoo/' : ces deux tests
  // vérifient le protocole général des trois moments, indépendamment du rapprochement par
  // service (D65, critère 1 bis) qui a sa propre section de test plus bas. Un chemin sous
  // 'apps/' ou 'services/odoo/' engagerait involontairement cette seconde exigence ici.
  test('process.env.X non déclarée est détectée', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': '# rien de déclaré\n',
      'services/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDECLARED || '';\n",
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
      'services/fixture/config.ts': "export const X = process.env.BABANA_TEST_UNDECLARED || '';\n",
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

describe('critère 1 bis (D65) -- la livraison est appariée au consommateur, jamais globale', () => {
  test('consommée par services/odoo/ mais livrée à un autre service seulement : détectée', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_WRONG_SERVICE=\n',
      'services/odoo/addons/babana/fixture.py': "import os\nX = os.environ.get('BABANA_TEST_WRONG_SERVICE')\n",
      // Livrée à `caddy`, jamais à `odoo` -- exactement la forme du défaut du 17 septembre
      // (BABANA_DOMAIN livrée à caddy, lue par share.py dans le conteneur odoo).
      'infra/compose.yaml':
        'services:\n  caddy:\n    environment:\n      BABANA_TEST_WRONG_SERVICE: ${BABANA_TEST_WRONG_SERVICE}\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.ok(
        problems.some(
          (p) => p.startsWith('BABANA_TEST_WRONG_SERVICE :') && p.includes('le service `odoo`') && p.includes('D65')
        ),
        `attendu un problème D65 pour BABANA_TEST_WRONG_SERVICE, trouvé :\n  ${problems.join('\n  ')}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('consommée par services/odoo/ et livrée au bloc odoo : plus rien ne remonte', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_RIGHT_SERVICE=\n',
      'services/odoo/addons/babana/fixture.py': "import os\nX = os.environ.get('BABANA_TEST_RIGHT_SERVICE')\n",
      'infra/compose.yaml':
        'services:\n  odoo:\n    environment:\n      BABANA_TEST_RIGHT_SERVICE: ${BABANA_TEST_RIGHT_SERVICE}\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.deepEqual(problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('consommée par apps/ mais seulement livrée à un conteneur compose : détectée', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_BUILD_ONLY=\n',
      'apps/fixture/config.ts': "export const X = process.env.BABANA_TEST_BUILD_ONLY || '';\n",
      'infra/compose.yaml':
        'services:\n  odoo:\n    environment:\n      BABANA_TEST_BUILD_ONLY: ${BABANA_TEST_BUILD_ONLY}\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.ok(
        problems.some(
          (p) => p.startsWith('BABANA_TEST_BUILD_ONLY :') && p.includes("l'environnement du build") && p.includes('D65')
        ),
        `attendu un problème D65 pour BABANA_TEST_BUILD_ONLY, trouvé :\n  ${problems.join('\n  ')}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('une variable consommée par odoo ET realtime doit être livrée aux deux', () => {
    const root = makeFixtureRepo({
      'infra/env/.env.example': 'BABANA_TEST_SHARED=\n',
      'services/odoo/addons/babana/fixture.py': "import os\nX = os.environ.get('BABANA_TEST_SHARED')\n",
      'services/realtime/src/fixture.ts': "export const X = process.env.BABANA_TEST_SHARED;\n",
      // odoo seulement -- realtime manque.
      'infra/compose.yaml':
        'services:\n  odoo:\n    environment:\n      BABANA_TEST_SHARED: ${BABANA_TEST_SHARED}\n',
    });
    try {
      const { problems } = checkVariableCoherence(root);
      assert.ok(
        problems.some((p) => p.startsWith('BABANA_TEST_SHARED :') && p.includes('le service `realtime`')),
        `attendu un problème D65 côté realtime, trouvé :\n  ${problems.join('\n  ')}`
      );
      assert.ok(
        !problems.some((p) => p.startsWith('BABANA_TEST_SHARED :') && p.includes('le service `odoo`')),
        `pas de problème attendu côté odoo (livré), trouvé :\n  ${problems.join('\n  ')}`
      );
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
