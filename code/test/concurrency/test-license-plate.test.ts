// 8 novembre : `make test` a échoué une fois sur « Cette immatriculation est déjà enregistrée » --
// `approveDriver` tirait 4 caractères en base 36 (1,7 million de plaques) contre une base qui
// accumule les motos de chaque passage (685 ce jour-là). D76 : un test ne dépend de rien qu'il
// n'ait posé lui-même -- ni du contenu de la base, ni du hasard d'un tirage trop étroit.
// Ne parle ni à Odoo ni à Redis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLicensePlate } from './helpers/odoo-session';

test('20 000 immatriculations de test, aucune en double', () => {
  const plates = new Set<string>();
  for (let i = 0; i < 20_000; i += 1) plates.add(testLicensePlate());
  assert.equal(plates.size, 20_000);
});
