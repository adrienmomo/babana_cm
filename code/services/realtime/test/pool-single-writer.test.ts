import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * D26 (L3-06R) : le pool des chauffeurs disponibles n'a qu'un seul écrivain -- le script
 * `redis/pool-eligibility.lua`. Vérifié par recherche plutôt que par seule revue (CLAUDE.md,
 * "Une règle de lint qui échoue vaut mieux qu'une revue qui oublie" ; amoa/questions/
 * REPONSES-2026-08-16-J7.md §2) : aucun fichier de ce service, en dehors des deux désignés
 * ci-dessous, ne peut contenir la commande GEOADD -- ni en TypeScript via ioredis (`.geoadd(`),
 * ni en Lua (`GEOADD`).
 *
 * Portée volontairement large (src ET test) : "geoadd" n'apparaît nulle part ailleurs, y compris
 * dans les fixtures de test, qui composent désormais le pool par le vrai chemin --
 * `test/helpers/pool.ts` (`setOnline` puis `addEligibleToPool`), plus jamais par un `GEOADD`
 * inconditionnel (l'ancien `addToPool`, retiré de `src/` le 17 août -- critère d'acceptation 6
 * bis, amoa/questions/REPONSES-2026-08-17.md §1 : une aide de test qui vivait dans `src/`
 * échappait à cette même recherche). Un balayage de tout le service ne produit donc aucun faux
 * positif, et couvre la formulation la plus stricte de la règle : "dans tout le service"
 * (amoa/specs/L3-temps-reel.md, L3-06, critère d'acceptation 6).
 */
const SERVICE_ROOT = join(__dirname, '..');
const SCAN_DIRS = ['src', 'test'];
const SCAN_EXTENSIONS = new Set(['.ts', '.lua']);

const ALLOWED_FILES = new Set([
  join(SERVICE_ROOT, 'src', 'redis', 'pool-eligibility.lua'),
  join(SERVICE_ROOT, 'src', 'redis', 'pool-eligibility.ts'), // le doc-commentaire cite "GEOADD"
  // Doc-commentaire descriptif (L3-03, "index géospatial Redis (GEOADD/GEOSEARCH)") : aucun appel
  // réel, geo-index.ts n'exécute plus GEOADD depuis le 17 août -- seul `pool-eligibility.lua` le
  // fait encore.
  join(SERVICE_ROOT, 'src', 'redis', 'geo-index.ts'),
  // Ce fichier lui-même : son propre texte nomme la commande interdite dans ses commentaires et
  // son message d'assertion.
  join(SERVICE_ROOT, 'test', 'pool-single-writer.test.ts'),
  // Doc-commentaire de l'aide de test (composer le pool "plutôt que par un GEOADD
  // inconditionnel") -- aucun appel réel, `putInPool` délègue entièrement à `addEligibleToPool`.
  join(SERVICE_ROOT, 'test', 'helpers', 'pool.ts'),
  // Commentaires descriptifs préexistants (L3-03, L3-05) qui nomment GEOADD/GEOSEARCH pour
  // expliquer pourquoi ces tests tournent contre un Redis réel -- plus aucun appel réel à GEOADD
  // dans ces fichiers depuis le 17 août (test/helpers/pool.ts compose le pool par le script
  // d'éligibilité, jamais par un GEOADD direct).
  join(SERVICE_ROOT, 'test', 'geo-index.test.ts'),
  join(SERVICE_ROOT, 'test', 'nearby.test.ts'),
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("D26 -- aucun GEOADD sur le pool en dehors du script d'éligibilité", () => {
  const offenders: string[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(SERVICE_ROOT, dir))) {
      if (!SCAN_EXTENSIONS.has(extname(file))) continue;
      if (ALLOWED_FILES.has(file)) continue;
      const content = readFileSync(file, 'utf8');
      if (/geoadd/i.test(content)) offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `GEOADD trouvé hors du script d'éligibilité et de ses appelants autorisés : ${offenders.join(', ')}`
  );
});
