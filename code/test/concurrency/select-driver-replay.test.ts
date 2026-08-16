// Preuve du critère 3 de L3-17 : « une requête select-driver rejouée par Odoo ne produit qu'une
// réservation ». Le rejeu doit être RÉELLEMENT provoqué -- un vrai conflit de sérialisation
// PostgreSQL (D25), pas un double appel de ce fichier qui simulerait la chose.
//
// **Pourquoi ce n'est PAS deux appels concurrents identiques (même chauffeur, même clé
// d'idempotence)** : une première version de ce test envoyait N requêtes select-driver
// réellement simultanées avec la même clé, en espérant que la mise en cache d'idempotence
// absorbe les doublons. Elle ne le fait PAS de façon fiable : N requêtes HTTP client
// authentiquement concurrentes deviennent N tentatives Odoo authentiquement concurrentes, chacune
// lisant `withIdempotency` AVANT qu'aucune n'ait eu le temps d'y écrire -- un défaut réel de
// conception, vérifié en pratique. Ce n'est tout simplement pas ce que fait Odoo : le rejeu de
// D25 est SÉQUENTIEL, une seule requête HTTP externe, retentée par le MÊME fil d'exécution après
// l'échec de la première tentative -- jamais deux fils concurrents.
//
// **La bonne façon de le provoquer réellement** : deux requêtes select-driver concurrentes visant
// la MÊME COURSE avec des CHAUFFEURS DIFFÉRENTS (donc des clés d'idempotence différentes, sans
// aliasing entre elles). Les deux verrouillent la même ligne `babana_ride` dans
// `action_propose::_lock_for_update()` (même mécanisme que L4-11, scénario 2 -- deux transitions
// concurrentes sur la même course). Le perdant subit un SerializationFailure et Odoo rejoue SA
// requête entière depuis le début -- SA propre clé d'idempotence, jamais celle du gagnant. C'est
// ce rejeu qui doit démontrer critère 3 : le second appel à /internal/reservations pour cette
// clé doit rejouer la première réponse, jamais retenter la réservation.
//
// **Deux connexions temps réel persistantes pour tout le fichier** (clientSocket, checkSocket),
// jamais une par itération : chaque `nearby.subscribe` compte dans la limitation de débit (L3-05,
// critère 6, 10 par fenêtre de 60 s par défaut) -- un abonnement par itération épuisait ce quota
// bien avant d'avoir prouvé quoi que ce soit sur plusieurs dizaines d'itérations, constaté en
// pratique. Un vrai client ne se réabonne pas à chaque action ; ce test ne le fait plus non plus.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before } from 'node:test';
import test from 'node:test';
import type WebSocket from 'ws';

import {
  approveDriver,
  callRideEndpoint,
  createRideRequest,
  readRideState,
  signIn,
  Session,
} from './helpers/odoo-session';
import {
  bringDriverOnline,
  openClientSubscription,
  seedDriverProfile,
  takeDriverOffline,
  waitForDriverVisible,
} from './helpers/realtime';

const RIDE_ORIGIN = { latitude: 4.05, longitude: 9.7 };
const ITERATIONS = Number(process.env.L3_17_REPLAY_ITERATIONS ?? 8);

let clientSession: Session;
let clientSocket: WebSocket;
let checkClient: Session;
let checkSocket: WebSocket;

before(async () => {
  clientSession = await signIn(`sub-l317-replay-client-${randomUUID()}`, 'client');
  clientSocket = await openClientSubscription(clientSession.accessToken, RIDE_ORIGIN);
  checkClient = await signIn(`sub-l317-replay-check-${randomUUID()}`, 'client');
  checkSocket = await openClientSubscription(checkClient.accessToken, RIDE_ORIGIN);
});

after(() => {
  clientSocket.close();
  checkSocket.close();
});

test(
  "select-driver rejoué par un vrai conflit de sérialisation PostgreSQL ne produit qu'une réservation (L3-17, critère 3)",
  { timeout: 180_000 },
  async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const driverASession = await signIn(`sub-l317-replay-a-${iteration}-${randomUUID()}`, 'driver');
      const driverBSession = await signIn(`sub-l317-replay-b-${iteration}-${randomUUID()}`, 'driver');
      const { driverPublicId: driverAId } = await approveDriver(driverASession, `a${iteration}`);
      const { driverPublicId: driverBId } = await approveDriver(driverBSession, `b${iteration}`);

      const driverASocket = await bringDriverOnline(driverASession.accessToken, RIDE_ORIGIN);
      const driverBSocket = await bringDriverOnline(driverBSession.accessToken, RIDE_ORIGIN);
      await seedDriverProfile(driverAId, `Chauffeur A${iteration}`);
      await seedDriverProfile(driverBId, `Chauffeur B${iteration}`);
      // Un seul abonnement persistant (before ci-dessus), jamais un par itération -- la
      // diffusion périodique déjà en cours suffit à faire apparaître les deux nouveaux chauffeurs.
      await waitForDriverVisible(clientSocket, [driverAId, driverBId], RIDE_ORIGIN);

      try {
        const { ridePublicId } = await createRideRequest(clientSession);

        // eslint-disable-next-line no-await-in-loop -- chaque itération doit être résolue avant
        // la suivante, la concurrence testée est DANS l'itération (les deux appels ci-dessous).
        const [responseA, responseB] = await Promise.all([
          callRideEndpoint(`/rides/${ridePublicId}/select-driver`, clientSession, { driverId: driverAId }),
          callRideEndpoint(`/rides/${ridePublicId}/select-driver`, clientSession, { driverId: driverBId }),
        ]);

        const successes = [responseA, responseB].filter((r) => r.status === 200);
        const failures = [responseA, responseB].filter((r) => r.status !== 200);

        assert.equal(
          successes.length,
          1,
          `itération ${iteration} : exactement un succès attendu sur les deux propositions concurrentes de la même course, obtenu ${successes.length} -- ${JSON.stringify([responseA, responseB])}`
        );
        assert.equal(failures.length, 1);
        assert.equal(
          failures[0]!.body?.error?.code,
          'RIDE_INVALID_TRANSITION',
          `itération ${iteration} : le perdant doit échouer proprement (course déjà proposée), pas par une réservation en double -- ${JSON.stringify(failures[0]!.body)}`
        );

        const winningDriverId = responseA.status === 200 ? driverAId : driverBId;
        const losingDriverId = responseA.status === 200 ? driverBId : driverAId;

        // eslint-disable-next-line no-await-in-loop
        assert.equal(await readRideState(ridePublicId), 'proposed');

        // Le gagnant reste réservé (retiré du pool, D26) : il ne réapparaîtra jamais dans
        // nearby.drivers tant que sa course n'est pas résolue -- seul le perdant, relâché, a
        // vocation à y revenir. La vérification "DRIVER_ALREADY_TAKEN" sur le gagnant plus bas
        // ne dépend donc pas de sa visibilité.
        // eslint-disable-next-line no-await-in-loop
        await waitForDriverVisible(checkSocket, losingDriverId, RIDE_ORIGIN);

        // Le perdant a été réservé une fois (par sa PREMIÈRE tentative, avant le conflit) puis
        // relâché -- jamais laissé bloqué, jamais réservé une seconde fois par un rejeu qui
        // recalculerait au lieu de rejouer. Preuve : une toute nouvelle course peut encore le
        // sélectionner immédiatement.
        // eslint-disable-next-line no-await-in-loop
        const freshRideForLoser = await createRideRequest(checkClient);
        // eslint-disable-next-line no-await-in-loop
        const loserRetry = await callRideEndpoint(
          `/rides/${freshRideForLoser.ridePublicId}/select-driver`,
          checkClient,
          { driverId: losingDriverId }
        );
        assert.equal(
          loserRetry.status,
          200,
          `itération ${iteration} : le chauffeur perdant doit être de nouveau sélectionnable, pas bloqué par une réservation orpheline -- ${JSON.stringify(loserRetry.body)}`
        );
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${freshRideForLoser.ridePublicId}/cancel`, checkClient, {
          reason: 'nettoyage (test L3-17)',
        });

        // Le gagnant, lui, reste réservé pour SA course -- une autre course ne peut pas le
        // prendre : preuve qu'il n'a pas été relâché par erreur pendant le traitement du rejeu.
        // eslint-disable-next-line no-await-in-loop
        const freshRideForWinner = await createRideRequest(checkClient);
        // eslint-disable-next-line no-await-in-loop
        const winnerStolen = await callRideEndpoint(
          `/rides/${freshRideForWinner.ridePublicId}/select-driver`,
          checkClient,
          { driverId: winningDriverId }
        );
        assert.equal(winnerStolen.status, 409);
        assert.equal(winnerStolen.body?.error?.code, 'DRIVER_ALREADY_TAKEN');
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${freshRideForWinner.ridePublicId}/cancel`, checkClient, {
          reason: 'nettoyage (test L3-17)',
        });

        // Referme la course principale : clientSession est réutilisé à l'itération suivante,
        // une seule course active à la fois par client (index unique partiel, L4-01).
        // eslint-disable-next-line no-await-in-loop
        await callRideEndpoint(`/rides/${ridePublicId}/cancel`, clientSession, {
          reason: 'nettoyage entre itérations (test L3-17)',
        });
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([takeDriverOffline(driverASocket), takeDriverOffline(driverBSocket)]);
      }
    }
  }
);
