#!/usr/bin/env node
// Vérifie les critères d'acceptation structurels de C-03 contre ride-state-machine.json.
// Aucune dépendance : exécutable dès cette tâche, avant que le monorepo n'existe.
// Usage: node docs/contracts/verify-ride-state-machine.js

const fs = require('fs');
const path = require('path');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'ride-state-machine.json'), 'utf8')
);

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

// Toute transition référence un état déclaré.
for (const t of data.transitions) {
  assert(data.states.includes(t.from), `transition ${t.from} -> ${t.to}: état source inconnu`);
  assert(data.states.includes(t.to), `transition ${t.from} -> ${t.to}: état cible inconnu`);
}

// Aucune transition dupliquée (même couple from/to).
const seen = new Set();
for (const t of data.transitions) {
  const key = `${t.from}->${t.to}`;
  assert(!seen.has(key), `transition dupliquée : ${key}`);
  seen.add(key);
}

// Critère d'acceptation 1 : chaque état apparaît en source et en cible,
// sauf les états listés dans neverTarget / neverSource.
const sources = new Set(data.transitions.map((t) => t.from));
const targets = new Set(data.transitions.map((t) => t.to));

for (const state of data.states) {
  const mustBeTarget = !data.neverTarget.includes(state);
  const mustBeSource = !data.neverSource.includes(state);
  if (mustBeTarget) {
    assert(targets.has(state), `état "${state}" attendu en cible d'au moins une transition`);
  }
  if (mustBeSource) {
    assert(sources.has(state), `état "${state}" attendu en source d'au moins une transition`);
  }
}

// neverTarget states must indeed never appear as target; neverSource must never appear as source.
for (const state of data.neverTarget) {
  assert(!targets.has(state), `état "${state}" déclaré neverTarget mais apparaît en cible`);
}
for (const state of data.neverSource) {
  assert(!sources.has(state), `état "${state}" déclaré neverSource mais apparaît en source`);
}

// Critère d'acceptation 3 de C-01 : exactement quatre moments d'écriture Odoo
// de la règle de partition, ni plus ni moins.
const partitionTransitions = data.transitions.filter((t) => t.odooWrite === 'partition_moment');
assert(
  partitionTransitions.length === 4,
  `4 moments d'écriture Odoo attendus (règle de partition), ${partitionTransitions.length} trouvés`
);
assert(
  data.odooPartitionMoments.length === 4,
  `odooPartitionMoments doit lister exactement 4 moments, ${data.odooPartitionMoments.length} trouvés`
);
for (const moment of data.odooPartitionMoments) {
  const [from, to] = moment.transition;
  const match = partitionTransitions.find((t) => t.from === from && t.to === to);
  assert(match, `moment "${moment.label}" (${from} -> ${to}) absent des transitions marquées partition_moment`);
}

// settled ne doit avoir aucune transition sortante (invariant 2 : rien ne change après règlement).
assert(!sources.has('settled'), '"settled" ne doit jamais être une source de transition');

// Toute transition irréversible vers settled ou cancelled doit être marquée irreversible: true.
for (const t of data.transitions) {
  if (t.to === 'settled' || t.to === 'cancelled') {
    assert(t.irreversible === true, `transition ${t.from} -> ${t.to} doit être irréversible`);
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} échec(s) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`OK — ${data.states.length} états, ${data.transitions.length} transitions, critères structurels 1 et 3 vérifiés.`);
