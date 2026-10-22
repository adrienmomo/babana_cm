// Preuve que la commande d'une course, rejouée par Odoo, ne laisse jamais un chauffeur réservé
// pour rien (critère 3 de L3-17, transposé à la sélection automatique : le serveur choisit le
// chauffeur le plus proche, le client ne le désigne plus). Le rejeu doit être RÉELLEMENT provoqué
// -- un vrai conflit de sérialisation PostgreSQL (D25), pas un double appel de ce fichier qui
// simulerait la chose.
//
// **Comment il est provoqué** : deux commandes concurrentes de la MÊME course, avec des clés
// d'idempotence différentes (deux requêtes HTTP distinctes, comme deux appareils du même client).
// Chacune demande au service temps réel le plus proche disponible -- l'une obtient A, l'autre B
// (A étant déjà réservé). Les deux verrouillent ensuite la même ligne `babana_ride` dans
// `action_propose::_lock_for_update()` : la perdante subit un SerializationFailure et Odoo rejoue
// SA requête entière, avec SA clé. Le service temps réel lui rejoue alors le chauffeur que sa
// première tentative avait réservé (jamais un troisième), et la transition, refusée cette fois
// (la course est déjà proposée), le fait relâcher.
//
// Ce qui doit en sortir, à chaque itération : un succès et un RIDE_INVALID_TRANSITION ; le
// chauffeur de la perdante de nouveau disponible (une nouvelle course le trouve) ; celui de la
// gagnante toujours réservé (une seconde nouvelle course ne trouve plus personne).
//
// Défaut que ce test a trouvé en l'écrivant : une première version de la commande vérifiait
// l'état de la course AVANT d'appeler le service temps réel. Au rejeu, ce contrôle voyait
// `proposed` et s'arrêtait -- le chauffeur réservé par la première tentative ne l'était jamais
// relâché, et il avait déjà reçu la proposition (services/odoo/addons/babana/services/dispatch.py).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before } from 'node:test';
import test from 'node:test';

import { approveDriver, callRideEndpoint, createRideRequest, readRideState, signIn, Session } from './helpers/odoo-session';
import { bringDriverOnline, seedDriverProfile, takeDriverOffline } from './helpers/realtime';
import { spotSequence } from './helpers/spots';

// Base propre à ce fichier (les autres fichiers tournent en parallèle, chacun loin des autres) ;
// un point par itération, son seul couple de chauffeurs posé dessus.
const nextSpot = spotSequence({ latitude: 4.13, longitude: 9.62 });
const ITERATIONS = Number(process.env.L3_17_REPLAY_ITERATIONS ?? 8);
// Le second chauffeur, à une quinzaine de mètres du point : dans le rayon des tests.
const METERS_PER_DEGREE = 111_000;

let clientSession: Session;
let checkClient: Session;

before(async () => {
  clientSession = await signIn(`sub-dispatch-replay-client-${randomUUID()}`, 'client');
  checkClient = await signIn(`sub-dispatch-replay-check-${randomUUID()}`, 'client');
});

test(
  "une commande rejouée par un vrai conflit de sérialisation PostgreSQL ne laisse aucun chauffeur réservé pour rien (L3-17, critère 3)",
  { timeout: 180_000 },
  async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const spot = nextSpot();
      const driverASession = await signIn(`sub-dispatch-replay-a-${iteration}-${randomUUID()}`, 'driver');
      const driverBSession = await signIn(`sub-dispatch-replay-b-${iteration}-${randomUUID()}`, 'driver');
      const { driverPublicId: driverAId } = await approveDriver(driverASession, `a${iteration}`);
      const { driverPublicId: driverBId } = await approveDriver(driverBSession, `b${iteration}`);

      const driverASocket = await bringDriverOnline(driverASession.accessToken, spot);
      const driverBSocket = await bringDriverOnline(driverBSession.accessToken, {
        latitude: spot.latitude + 15 / METERS_PER_DEGREE,
        longitude: spot.longitude,
      });
      // `try` englobe tout ce qui suit l'ouverture des connexions (D70) : un échec ne doit jamais
      // laisser deux WebSocket ouverts qui empêcheraient le processus de test de se terminer.
      try {
        await seedDriverProfile(driverAId, `Chauffeur A${iteration}`);
        await seedDriverProfile(driverBId, `Chauffeur B${iteration}`);

        const { ridePublicId } = await createRideRequest(clientSession, spot);

        // eslint-disable-next-line no-await-in-loop -- chaque itération doit être résolue avant
        // la suivante, la concurrence testée est DANS l'itération (les deux appels ci-dessous).
        const [first, second] = await Promise.all([
          callRideEndpoint(`/rides/${ridePublicId}/dispatch`, clientSession, {}, randomUUID()),
          callRideEndpoint(`/rides/${ridePublicId}/dispatch`, clientSession, {}, randomUUID()),
        ]);

        const successes = [first, second].filter((r) => r.status === 200);
        const failures = [first, second].filter((r) => r.status !== 200);
        assert.equal(
          successes.length,
          1,
          `itération ${iteration} : exactement un succès attendu sur deux commandes concurrentes de la même course -- ${JSON.stringify([first, second])}`
        );
        assert.equal(
          failures[0]!.body?.error?.code,
          'RIDE_INVALID_TRANSITION',
          `itération ${iteration} : la perdante doit échouer proprement (course déjà proposée) -- ${JSON.stringify(failures[0]!.body)}`
        );
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await readRideState(ridePublicId), 'proposed');

        const winningDriverId = successes[0]!.body.assignedDriverId as string;
        assert.ok([driverAId, driverBId].includes(winningDriverId));
        const losingDriverId = winningDriverId === driverAId ? driverBId : driverAId;

        // Le chauffeur de la perdante a été relâché : une nouvelle course au même point le trouve.
        // eslint-disable-next-line no-await-in-loop
        const freshForLoser = await createRideRequest(checkClient, spot);
        // eslint-disable-next-line no-await-in-loop
        const loserFound = await callRideEndpoint(`/rides/${freshForLoser.ridePublicId}/dispatch`, checkClient, {});
        assert.equal(
          loserFound.status,
          200,
          `itération ${iteration} : le chauffeur de la commande perdante doit être de nouveau disponible -- ${JSON.stringify(loserFound.body)}`
        );
        assert.equal(loserFound.body.assignedDriverId, losingDriverId);

        // Celui de la gagnante, lui, est resté réservé pour SA course : plus personne à portée.
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${freshForLoser.ridePublicId}/cancel`, checkClient, { reason: 'nettoyage (test)' });
        // eslint-disable-next-line no-await-in-loop
        const freshForWinner = await createRideRequest(checkClient, spot);
        // eslint-disable-next-line no-await-in-loop
        const winnerStolen = await callRideEndpoint(`/rides/${freshForWinner.ridePublicId}/dispatch`, checkClient, {});
        if (winnerStolen.status === 200) {
          assert.notEqual(
            winnerStolen.body.assignedDriverId,
            winningDriverId,
            `itération ${iteration} : le chauffeur de la commande gagnante a été proposé à une autre course`
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${freshForWinner.ridePublicId}/cancel`, checkClient, { reason: 'nettoyage (test)' });
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${ridePublicId}/cancel`, clientSession, { reason: 'nettoyage entre itérations (test)' });
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([takeDriverOffline(driverASocket), takeDriverOffline(driverBSocket)]);
      }
    }
  }
);
