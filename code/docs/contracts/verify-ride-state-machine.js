#!/usr/bin/env node
// Vérifie les critères d'acceptation structurels de C-03 contre ride-state-machine.json.
// Aucune dépendance : exécutable dès cette tâche, avant que le monorepo n'existe.
// Usage: node docs/contracts/verify-ride-state-machine.js
//
// Révision C-03R (10 août 2026) : la règle de partition n'est plus un compte de quatre
// moments (invalidé par D10, voir amoa/01-architecture.md §2). Ce script ne compte plus les
// écritures Odoo ; il vérifie qu'aucune d'elles n'est rattachée à autre chose qu'un événement
// métier nommé, et qu'aucune n'est déclenchée par un minuteur ou un tick de position.

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

for (const state of data.neverTarget) {
  assert(!targets.has(state), `état "${state}" déclaré neverTarget mais apparaît en cible`);
}
for (const state of data.neverSource) {
  assert(!sources.has(state), `état "${state}" déclaré neverSource mais apparaît en source`);
}

// settled ne doit avoir aucune transition sortante (invariant 2 : rien ne change après règlement).
assert(!sources.has('settled'), '"settled" ne doit jamais être une source de transition');

// Toute transition irréversible vers settled ou cancelled doit être marquée irreversible: true.
for (const t of data.transitions) {
  if (t.to === 'settled' || t.to === 'cancelled') {
    assert(t.irreversible === true, `transition ${t.from} -> ${t.to} doit être irréversible`);
  }
}

// Critère d'acceptation 3 (révisé) : aucune écriture Odoo n'est déclenchée par le temps
// écoulé, la distance parcourue ou l'expiration d'un compte à rebours sans effet métier.
// Traduit en trois vérifications mécaniques :

// 3a. Toute transition qui écrit dans Odoo (odooWrite: true) doit être rattachée à un
// événement métier nommé de la liste businessEvents — une écriture anonyme n'est pas
// admissible, elle doit toujours être imputable à une décision humaine explicite.
const businessEventIds = new Set(data.businessEvents.map((e) => e.id));
for (const t of data.transitions) {
  if (t.odooWrite === true) {
    assert(
      typeof t.businessEvent === 'string' && businessEventIds.has(t.businessEvent),
      `transition ${t.from} -> ${t.to} écrit dans Odoo mais n'est rattachée à aucun événement métier déclaré`
    );
  } else {
    assert(
      t.businessEvent === undefined,
      `transition ${t.from} -> ${t.to} n'écrit pas dans Odoo mais porte un événement métier ("${t.businessEvent}") — incohérent`
    );
  }
}

// 3b. Chacun des sept événements métier de la règle de partition (amoa/01-architecture.md §2)
// est effectivement utilisé par au moins une transition — sinon un événement qui devrait
// écrire a été oublié, silencieusement.
for (const event of data.businessEvents) {
  const used = data.transitions.some((t) => t.businessEvent === event.id);
  assert(used, `événement métier "${event.id}" (${event.label}) déclaré mais jamais rattaché à une transition`);
}

// 3c. Aucun déclencheur de transition n'est un mécanisme purement temporel ou positionnel
// (tick de position, recalcul d'ETA, accumulation de distance, minuteur) — ces mécanismes
// vivent exclusivement dans Redis et ne doivent jamais apparaître comme le déclencheur d'une
// écriture Odoo.
for (const t of data.transitions) {
  for (const forbidden of data.neverWritingTriggers) {
    assert(
      !String(t.trigger).includes(forbidden),
      `transition ${t.from} -> ${t.to} : déclencheur "${t.trigger}" évoque un mécanisme temporel/positionnel interdit ("${forbidden}")`
    );
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} échec(s) :`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `OK — ${data.states.length} états, ${data.transitions.length} transitions, ${data.businessEvents.length} événements métier, critères structurels vérifiés.`
);
