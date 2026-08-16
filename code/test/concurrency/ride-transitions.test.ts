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
import { after, before } from 'node:test';
import test from 'node:test';
import type WebSocket from 'ws';

import {
  approveDriver,
  callRideEndpoint,
  createRideRequest,
  execute,
  readRideState,
  Session,
  signIn,
} from './helpers/odoo-session';
import { makeDriverSelectable, waitForDriverVisible } from './helpers/realtime';

// Même point que odoo-session.ts::createRideRequest -- le chauffeur doit être positionné là où
// nearby.subscribe le cherchera (précondition C-03, L3-17).
const RIDE_ORIGIN = { latitude: 4.05, longitude: 9.7 };

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
  clientSocket: WebSocket;
}

const openSockets: WebSocket[] = [];

after(() => {
  for (const socket of openSockets) socket.close();
});

async function setUpActors(label: string): Promise<Actors> {
  const clientSession = await signIn(uniqueSub(`${label}-client`), 'client');
  const driverSession = await signIn(uniqueSub(`${label}-driver`), 'driver');
  const { driverPublicId } = await approveDriver(driverSession, label);
  // L3-17 : select-driver réserve réellement contre le service temps réel (D26) -- le chauffeur
  // doit être réellement en ligne, positionné, et montré à CE client (précondition C-03, critère
  // 8) avant de pouvoir être sélectionné. Connexions laissées ouvertes pour toute la durée du
  // test (voir makeDriverSelectable) : ce fichier réutilise le même chauffeur sur de nombreuses
  // itérations dont la durée cumulée peut dépasser la période de grâce de déconnexion (chauffeur)
  // ou le TTL de la dernière liste envoyée (client) -- un vrai client et un vrai chauffeur
  // resteraient connectés plutôt que de se déconnecter entre deux actions.
  const { driverSocket, clientSockets } = await makeDriverSelectable(
    driverSession.accessToken,
    driverPublicId,
    RIDE_ORIGIN,
    [clientSession.accessToken]
  );
  openSockets.push(driverSocket, ...clientSockets);
  return { clientSession, driverSession, driverPublicId, clientSocket: clientSockets[0]! };
}

async function proposedRide(actors: Actors, debugLabel = ''): Promise<string> {
  // Précondition C-03 (critère 8) réévaluée avant chaque sélection : la diffusion périodique en
  // arrière-plan (NEARBY_BROADCAST_INTERVAL_SECONDS) peut avoir vidé la dernière liste envoyée
  // pendant qu'un ACCEPT précédent engageait momentanément ce même chauffeur (D26) -- un vrai
  // client attendrait de le revoir disponible avant de le resélectionner, ce test doit en faire
  // autant plutôt que de dépendre d'un minuteur d'arrière-plan mal synchronisé avec ses propres
  // itérations.
  await waitForDriverVisible(actors.clientSocket, actors.driverPublicId, RIDE_ORIGIN);

  const { ridePublicId } = await createRideRequest(actors.clientSession);
  const select = await callRideEndpoint(`/rides/${ridePublicId}/select-driver`, actors.clientSession, {
    driverId: actors.driverPublicId,
  });
  assert.equal(
    select.status,
    200,
    `select-driver a échoué en préparation (${debugLabel}) : ${JSON.stringify(select.body)}`
  );
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
      const ridePublicId = await proposedRide(actors, `s1 iteration ${iteration}`);

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
// 'proposed'. Rédaction corrigée le 16 août 2026 (D25, amoa/questions/REPONSES-2026-08-16.md) :
// accept et cancel ne s'excluent pas, c'est une séquence légitime -- 'assigned' est annulable
// (C-03, L4-07). Ce que ce scénario prouve n'est donc PAS l'exclusion mutuelle ("un seul
// succès"), c'est l'indépendance à l'ordonnanceur : quel que soit l'ordre dans lequel Postgres
// a pris son instantané, l'état final est TOUJOURS 'cancelled', et aucune transition valide
// n'est jamais refusée pour cause de concurrence (critère 2 bis de L4-11) :
//
//   | Ordre                | Résultat                                             |
//   |-----------------------|------------------------------------------------------|
//   | cancel gagne d'abord | cancelled ; accept échoue à bon droit (RIDE_INVALID_TRANSITION) |
//   | accept gagne d'abord | assigned, PUIS cancel réussit aussi -- les deux aboutissent |
//
// L'exclusion mutuelle, elle, se prouve sur une paire réellement exclusive : scénario 1 (deux
// accept) ou accept contre reject sur la même proposition -- pas ici.

test(
  `scénario 2 -- annulation client contre acceptation chauffeur (${ITERATIONS} itérations)`,
  { timeout: 180_000 },
  async () => {
    const actors = await setUpActors('s2');
    let bothSucceeded = 0;
    let onlyCancelSucceeded = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const ridePublicId = await proposedRide(actors);

      const [acceptResponse, cancelResponse] = await Promise.all([
        callRideEndpoint(`/rides/${ridePublicId}/accept`, actors.driverSession),
        callRideEndpoint(`/rides/${ridePublicId}/cancel`, actors.clientSession, {
          reason: 'changement de plan (test L4-11)',
        }),
      ]);

      // L'annulation n'échoue JAMAIS dans ce scénario : depuis 'proposed' (cancel gagne) comme
      // depuis 'assigned' (accept gagne d'abord), 'cancelled' est une transition valide (C-03).
      // Un cancel refusé ici serait exactement le défaut de D25 : une transition légitime
      // rejetée selon la microseconde de l'instantané Postgres, pas selon une règle.
      assert.equal(
        cancelResponse.status,
        200,
        `itération ${iteration} : l'annulation doit toujours aboutir (assigned est annulable) -- ` +
          `reçu ${cancelResponse.status} : ${JSON.stringify(cancelResponse.body)}`,
      );

      if (acceptResponse.status === 200) {
        bothSucceeded += 1;
      } else {
        onlyCancelSucceeded += 1;
        // Le perdant doit échouer proprement, avec le vrai motif métier -- pas un
        // SerializationFailure brut remonté en 500, et pas davantage RIDE_INVALID_TRANSITION
        // pour une raison qui n'est plus valable après rejeu.
        assert.equal(
          acceptResponse.body?.error?.code,
          'RIDE_INVALID_TRANSITION',
          `itération ${iteration} : accept perdant doit recevoir RIDE_INVALID_TRANSITION, reçu ${JSON.stringify(acceptResponse.body)}`,
        );
      }

      const finalState = await readRideState(ridePublicId);
      assert.equal(
        finalState,
        'cancelled',
        `itération ${iteration} : état final attendu 'cancelled' (accept=${acceptResponse.status}), obtenu '${finalState}'`,
      );

      // La course est déjà 'cancelled' : rien à libérer côté chauffeur (freeUpDriver ne fait
      // quelque chose que depuis 'assigned', jamais atteint ici en fin d'itération).
      await freeUpDriver(actors, ridePublicId);
    }

    // Pas une exigence de répartition précise -- seulement la preuve que les deux ordres
    // d'arrivée se produisent réellement sur le nombre d'itérations, pas qu'un seul chemin est
    // exercé par un biais de timing du test lui-même.
    assert.ok(
      bothSucceeded > 0 && onlyCancelSucceeded > 0,
      `les deux ordres doivent se produire au moins une fois sur ${ITERATIONS} itérations ` +
        `(accept+cancel=${bothSucceeded}, cancel seul=${onlyCancelSucceeded}) -- sinon le test ne prouve qu'un seul chemin`,
    );
  },
);

// --- Scénario 3 : encaissement concurrent --------------------------------------------------

test('scénario 3 -- encaissement concurrent', {
  skip: 'POST /rides/{id}/settle non implémenté (L4-03 dépend de L4-05/L5-01, hors de ce lot) -- voir amoa/questions/L4-03.md',
}, () => {});
