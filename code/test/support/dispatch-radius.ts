// Rayon de recherche d'un chauffeur (babana.dispatch_radius_meters) pendant ces suites.
//
// La course part au chauffeur disponible le plus proche (le client ne choisit plus). Avec le rayon
// d'exploitation (plusieurs kilomètres), « le plus proche » d'un scénario serait souvent le
// chauffeur d'un autre fichier lancé en parallèle, ou celui d'un scénario précédent resté en
// ligne. Le temps de la suite, le rayon est donc réduit à quelques dizaines de mètres, et chaque
// scénario pose son chauffeur à son propre point de prise en charge (`../concurrency/helpers/
// spots.ts`, points espacés d'une centaine de mètres) : son chauffeur est alors le seul à portée.
//
// `set` mémorise la valeur en place puis pose celle des tests ; `restore` remet la valeur
// mémorisée (ou supprime le paramètre s'il n'existait pas) -- appelé même quand les tests
// échouent (package.json). Un `set` répété sans `restore` (suite interrompue) garde la valeur
// d'origine déjà mémorisée, jamais celle des tests.
//
// Usage : tsx support/dispatch-radius.ts set|restore
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../concurrency/helpers/odoo-session';

export const TEST_DISPATCH_RADIUS_METERS = 40;
const PARAM = 'babana.dispatch_radius_meters';
const SAVED = join(tmpdir(), 'babana-test-dispatch-radius.json');

async function main(mode: string | undefined): Promise<void> {
  if (mode === 'set') {
    if (!existsSync(SAVED)) {
      const previous = await execute<string | false>('ir.config_parameter', 'get_param', [PARAM, false]);
      writeFileSync(SAVED, JSON.stringify({ previous }));
    }
    await execute('ir.config_parameter', 'set_param', [PARAM, String(TEST_DISPATCH_RADIUS_METERS)]);
    return;
  }
  if (mode === 'restore') {
    if (!existsSync(SAVED)) return;
    const { previous } = JSON.parse(readFileSync(SAVED, 'utf8')) as { previous: string | false };
    // set_param(clé, False) supprime le paramètre : le code retombe alors sur sa valeur par défaut.
    await execute('ir.config_parameter', 'set_param', [PARAM, previous]);
    unlinkSync(SAVED);
    return;
  }
  throw new Error('usage : tsx support/dispatch-radius.ts set|restore');
}

if (require.main === module) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
