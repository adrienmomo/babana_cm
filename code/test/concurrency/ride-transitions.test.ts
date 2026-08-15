// Test de concurrence sur les transitions de babana.ride (L4-11), contre la pile réelle
// démarrée par `make up` -- pas contre le harnais Odoo. Extrait de L4-02 le 11 août 2026 :
// TransactionCase enveloppe chaque test dans une transaction annulée à la fin, une seconde
// connexion réelle n'y voit rien ou attend un verrou qui ne se libère qu'à la fin du test.
// Le mécanisme (_lock_for_update(), babana_ride_state.py) était déjà vérifié manuellement à
// l'époque ; ce fichier en est la preuve automatisée, en environnement réel.
//
// Un seul client et un seul chauffeur approuvé par scénario, réutilisés à travers les
// itérations (une course fraîche à chaque itération, refermée -- annulée -- avant la
// suivante) : signIn() passe par le vrai /auth/google (L1-01, critère 10, limitation de débit
// par adresse IP) -- toutes les requêtes de ce fichier partagent la même origine, un sign-in
// par itération épuiserait ce quota bien avant d'avoir prouvé quoi que ce soit sur le
// verrouillage des transitions, qui est le seul sujet de ce fichier.
//
// Scénario 3 (encaissement concurrent) n'est pas ici : POST /rides/{id}/settle n'est pas
// implémenté (L4-03 -- dépend du compte courant chauffeur, L4-05/L5-01, hors de ce lot). Voir
// amoa/questions/L4-03.md. Un test.skip explicite plutôt qu'une omission silencieuse.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before } from 'node:test';
import test from 'node:test';

import {
  approveDriver,
  callRideEndpoint,
  createRideRequest,
  execute,
  readRideState,
  Session,
  signIn,
} from './helpers/odoo-session';

// Toutes les requêtes de ce fichier partagent la même adresse IP source (la machine qui
// exécute le test) -- la limitation de débit sur la création de candidature chauffeur (L1-01,
// critère 10, par adresse) s'appliquerait donc à ce test lui-même, sans rapport avec ce qu'il
// vérifie. Relevée une fois pour la durée de ce fichier ; ir.config_parameter reste sinon à sa
// valeur de production partout ailleurs (invariant 5 -- paramétrable, pas codé en dur dans la
// vérification elle-même).
before(async () => {
  await execute('ir.config_parameter', 'set_param', ['babana.driver_candidacy_rate_limit_max', '1000']);
});

const ITERATIONS = Number(process.env.L4_11_ITERATIONS ?? 20);
const CONCURRENCY = Number(process.env.L4_11_CONCURRENCY ?? 8);

function uniqueSub(label: string): string {
  return `sub-l411-${label}-${randomUUID()}`;
}

interface Actors {
  clientSession: Session;
  driverSession: Session;
  driverPublicId: string;
}

async function setUpActors(label: string): Promise<Actors> {
  const clientSession = await signIn(uniqueSub(`${label}-client`), 'client');
  const driverSession = await signIn(uniqueSub(`${label}-driver`), 'driver');
  const { driverPublicId } = await approveDriver(driverSession, label);
  return { clientSession, driverSession, driverPublicId };
}

async function proposedRide(actors: Actors): Promise<string> {
  const { ridePublicId } = await createRideRequest(actors.clientSession);
  const select = await callRideEndpoint(`/rides/${ridePublicId}/select-driver`, actors.clientSession, {
    driverId: actors.driverPublicId,
  });
  assert.equal(select.status, 200, `select-driver a échoué en préparation : ${JSON.stringify(select.body)}`);
  return ridePublicId;
}

/** Referme la course (si besoin) pour que le chauffeur redevienne disponible à l'itération
 * suivante -- 'proposed'/'assigned' sont tous deux des états actifs (index unique partiel de
 * L4-01) : un chauffeur déjà engagé sur l'un des deux ne peut pas être proposé sur une autre
 * course tant qu'il n'en est pas sorti. */
async function freeUpDriver(actors: Actors, ridePublicId: string): Promise<void> {
  const state = await readRideState(ridePublicId);
  if (state === 'assigned') {
    await callRideEndpoint(`/rides/${ridePublicId}/cancel`, actors.driverSession, {
      reason: 'nettoyage entre itérations (test L4-11)',
    });
  }
}

// --- Scénario 1 : acceptation concurrente ------------------------------------------------------
// N appels réellement simultanés à /accept, par le MÊME chauffeur (une salve de doubles-appels
// réseau -- le cas concret que _lock_for_update() protège) sur la même course 'proposed'.
// Exactement un succès, N-1 échecs explicites, à chaque itération.

test(
  `scénario 1 -- acceptation concurrente (${ITERATIONS} itérations x ${CONCURRENCY} appels simultanés)`,
  { timeout: 180_000 },
  async () => {
    const actors = await setUpActors('s1');

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ridePublicId = await proposedRide(actors);

      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          callRideEndpoint(`/rides/${ridePublicId}/accept`, actors.driverSession),
        ),
      );

      const successes = responses.filter((r) => r.status === 200);
      const failures = responses.filter((r) => r.status !== 200);

      assert.equal(
        successes.length,
        1,
        `itération ${iteration} : ${successes.length} succès sur ${CONCURRENCY} appels simultanés (attendu : exactement 1) -- ${JSON.stringify(responses.map((r) => r.status))}`,
      );
      assert.equal(failures.length, CONCURRENCY - 1);
      for (const failure of failures) {
        assert.equal(
          failure.body?.error?.code,
          'RIDE_INVALID_TRANSITION',
          `code d'erreur explicite attendu, reçu : ${JSON.stringify(failure.body)}`,
        );
      }

      const finalState = await readRideState(ridePublicId);
      assert.equal(finalState, 'assigned', `itération ${iteration} : état final incohérent (${finalState})`);

      await freeUpDriver(actors, ridePublicId);
    }
  },
);

// --- Scénario 2 : transitions divergentes ------------------------------------------------------
// Un client annule pendant qu'un chauffeur accepte, concurrentement, sur la même course
// 'proposed'. Une seule des deux transitions gagne, l'état final est cohérent
// ('assigned' ou 'cancelled', jamais un état intermédiaire), le perdant reçoit une erreur
// compréhensible.

test(
  `scénario 2 -- annulation client contre acceptation chauffeur (${ITERATIONS} itérations)`,
  { timeout: 180_000 },
  async () => {
    const actors = await setUpActors('s2');
    let assignedWins = 0;
    let cancelledWins = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ridePublicId = await proposedRide(actors);

      const [acceptResponse, cancelResponse] = await Promise.all([
        callRideEndpoint(`/rides/${ridePublicId}/accept`, actors.driverSession),
        callRideEndpoint(`/rides/${ridePublicId}/cancel`, actors.clientSession, {
          reason: 'changement de plan (test L4-11)',
        }),
      ]);

      const outcomes = [acceptResponse, cancelResponse];
      const successes = outcomes.filter((r) => r.status === 200);
      assert.equal(
        successes.length,
        1,
        `itération ${iteration} : ${successes.length} transition(s) réussie(s) sur 2 (attendu : exactement 1) -- accept=${acceptResponse.status} cancel=${cancelResponse.status}`,
      );

      const loser = successes[0] === acceptResponse ? cancelResponse : acceptResponse;
      assert.notEqual(loser.status, 200);
      assert.ok(
        loser.body?.error?.code,
        `le perdant doit recevoir un code d'erreur explicite -- ${JSON.stringify(loser.body)}`,
      );

      const finalState = await readRideState(ridePublicId);
      assert.ok(
        finalState === 'assigned' || finalState === 'cancelled',
        `itération ${iteration} : état final incohérent (${finalState}), ni assigned ni cancelled`,
      );
      if (finalState === 'assigned') assignedWins += 1;
      else cancelledWins += 1;

      await freeUpDriver(actors, ridePublicId);
    }

    // Pas une exigence de répartition précise (le point n'est pas l'équité entre les deux
    // transitions) -- seulement la preuve que les deux issues sont bien atteignables, pas
    // qu'une des deux gagne toujours par un biais de timing du test lui-même.
    assert.ok(
      assignedWins > 0 && cancelledWins > 0,
      `les deux issues doivent se produire au moins une fois sur ${ITERATIONS} itérations (assigned=${assignedWins}, cancelled=${cancelledWins}) -- sinon le test ne prouve qu'un seul chemin`,
    );
  },
);

// --- Scénario 3 : encaissement concurrent --------------------------------------------------

test('scénario 3 -- encaissement concurrent', {
  skip: 'POST /rides/{id}/settle non implémenté (L4-03 dépend de L4-05/L5-01, hors de ce lot) -- voir amoa/questions/L4-03.md',
}, () => {});
