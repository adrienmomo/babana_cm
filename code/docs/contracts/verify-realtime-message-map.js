#!/usr/bin/env node
// C-02, critère d'acceptation 5 (ajouté le 27 août 2026 -- amoa/questions/REPONSES-2026-08-27.md,
// amoa/rapport-nuit-J19.md). Vérifie que chaque message du contrat temps réel a une entrée dans
// realtime-message-map.json, et que chaque entrée 'pending' porte une raison explicite -- jamais
// un message ni oublié ni laissé sans explication. Même patron que verify-ride-state-machine.js
// (C-03) : un script Node autonome, sans dépendance, chaîné après `npm test` (package.json).
//
// La liste des messages attendus se DÉRIVE du contrat lui-même (packages/contracts/src/realtime/
// {client-to-server,server-to-client}.ts), jamais recopiée à la main -- une extraction textuelle
// des appels envelopeSchema('nom', ...), pas un import du paquet compilé : ce script tourne en
// Node pur, avant tout build, comme verify-ride-state-machine.js.
//
// Usage: node docs/contracts/verify-realtime-message-map.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const map = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'realtime-message-map.json'), 'utf8')
);

function extractMessageNames(relativePath, direction) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const names = [];
  const pattern = /envelopeSchema\(\s*'([a-z]+(?:\.[a-z]+)*)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    names.push({ name: match[1], direction });
  }
  return names;
}

const contractMessages = [
  ...extractMessageNames('packages/contracts/src/realtime/client-to-server.ts', 'client-to-server'),
  ...extractMessageNames('packages/contracts/src/realtime/server-to-client.ts', 'server-to-client'),
];

if (contractMessages.length === 0) {
  throw new Error(
    'Aucun message extrait du contrat (envelopeSchema(...)) -- le motif d\'extraction a-t-il ' +
      'divergé de packages/contracts/src/realtime/*.ts ?'
  );
}

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const byName = new Map();
for (const entry of map.messages) {
  assert(!byName.has(entry.name), `"${entry.name}" apparaît deux fois dans realtime-message-map.json`);
  byName.set(entry.name, entry);
}

const contractNames = new Set(contractMessages.map((m) => m.name));

// Critère 5, première moitié : tout message du contrat a une entrée -- sinon ni émetteur, ni
// consommateur, ni attente n'est documenté nulle part, et c'est exactement le trou qui a laissé
// passer trois nuits de suite un manque de découpage (amoa/rapport-nuit-J19.md).
for (const { name, direction } of contractMessages) {
  const entry = byName.get(name);
  if (!entry) {
    failures.push(
      `message "${name}" (${direction}) du contrat n'a aucune entrée dans realtime-message-map.json`
    );
    continue;
  }
  assert(
    entry.direction === direction,
    `"${name}" : direction déclarée "${entry.direction}", le contrat dit "${direction}"`
  );
  assert(
    entry.status === 'wired' || entry.status === 'pending',
    `"${name}" : status "${entry.status}" invalide (attendu "wired" ou "pending")`
  );
  if (entry.status === 'wired') {
    assert(
      typeof entry.emitter === 'string' && entry.emitter.trim().length > 0,
      `"${name}" : status "wired" mais "emitter" vide ou absent`
    );
    assert(
      typeof entry.consumer === 'string' && entry.consumer.trim().length > 0,
      `"${name}" : status "wired" mais "consumer" vide ou absent`
    );
  }
  if (entry.status === 'pending') {
    // Critère 5, seconde moitié : « ou est explicitement déclaré en attente » -- la mention
    // explicite exigée par le critère est ce champ, jamais un statut nu sans justification.
    assert(
      typeof entry.reason === 'string' && entry.reason.trim().length > 0,
      `"${name}" : status "pending" sans "reason" -- la mention explicite qu'exige le critère 5`
    );
  }
}

// Entrée périmée : un message retiré du contrat, ou renommé, dont la carte garderait une trace
// fausse -- aussi trompeur qu'un message manquant.
for (const name of byName.keys()) {
  if (!contractNames.has(name)) {
    failures.push(`"${name}" figure dans realtime-message-map.json mais n'existe plus dans le contrat`);
  }
}

if (failures.length > 0) {
  console.error(
    `C-02, critère 5 : cartographie des messages incomplète ou incohérente (${failures.length}) :\n`
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  const pending = map.messages.filter((m) => m.status === 'pending');
  const wired = map.messages.length - pending.length;
  console.log(
    `C-02, critère 5 : ${contractMessages.length} messages du contrat, tous cartographiés ` +
      `(${wired} câblés, ${pending.length} en attente).`
  );
  if (pending.length > 0) {
    console.log('  En attente :');
    for (const m of pending) {
      console.log(`    - ${m.name} (${m.direction}) : ${m.reason}`);
    }
  }
}
