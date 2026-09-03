// L10-01 -- scénarios de bout en bout, contre l'environnement complet démarré par `make up`
// (Odoo, service temps réel, Redis, PostgreSQL). Le filet qui protège les chemins qui
// TRAVERSENT plusieurs composants -- le jeton entre Odoo et le temps réel, l'état de course entre
// Redis et PostgreSQL, l'URL signée entre le conteneur et le navigateur : c'est là que ce projet a
// trouvé ses défauts les plus coûteux, toujours sur le chemin, jamais dans une pièce isolée.
//
// Les apps mobiles ne sont pas pilotées (spécification) : chaque étape appelle le VRAI contrat
// HTTP (`@babana/api-client`, comme test/http-contract) ou le VRAI WebSocket (comme
// test/concurrency) -- jamais un raccourci RPC pour une transition qu'un vrai client
// déclencherait. Les seuls appels RPC directs (`execute()`) servent à PRÉPARER un fixture
// (approbation de dossier, paramètre de plafond) ou à LIRE un état pour vérification -- jamais à
// écrire une transition de course à la place de l'API.
//
// Écart documenté (amoa/questions/L10-01.md), à lire avant de modifier ce fichier : deux points
// du critère d'acceptation ne sont PAS vérifiables tels quels aujourd'hui --
//   - « journal d'audit complet » (étape 9) : `babana.audit.log` (L8-09) n'existe pas encore
//     (`babana_ride_state.py::_babana_journalize` ne fait que journaliser dans les logs
//     applicatifs, son propre commentaire le dit : « point d'accroche unique pour L8-09 »).
//   - un bouton ou un paramètre « notifications désactivées » (L7-06) n'existe pas non plus --
//     le mécanisme qui répond au besoin RÉEL de L7-06 (« aucune notification n'est un canal
//     unique ») est `session.resync` (L3-11), déjà construit et déjà exercé par le test de
//     résilience (L3-14). Le scénario 5 ci-dessous exerce CE mécanisme réel, sans jamais
//     enregistrer de jeton d'appareil pour ses deux acteurs -- aucun canal de notification
//     n'existe alors pour eux, ce qui est la forme la plus honnête de « désactivées » que l'API
//     réelle permette de produire aujourd'hui.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { http } from '@babana/contracts';
import { execute, readRideState } from '../concurrency/helpers/odoo-session';
import { acceptProposalOverWs, bringDriverOnline, resync, sendPosition, waitForDriverVisible } from '../concurrency/helpers/realtime';
import {
  closeAllSockets,
  ensureSupervisor,
  rejectProposalOverWs,
  setUpRideActors,
  trackRideAndAwaitPosition,
  type HttpClient,
  type RideActors,
} from './helpers/actors';
import { DESTINATION, EN_ROUTE_POSITION, ORIGIN } from './fixtures/geo';

// Même raison que test/concurrency/ride-transitions.test.ts, before() : chaque scénario ci-dessous
// authentifie au moins un nouveau chauffeur (signIn(..., 'driver') crée une candidature), et ce
// fichier en crée plusieurs sur la même adresse IP source (L1-01, critère 10). Relevé pour la
// durée de ce fichier seulement -- paramétrable, jamais codé en dur (invariant 5).
before(async () => {
  await execute('ir.config_parameter', 'set_param', ['babana.driver_candidacy_rate_limit_max', '1000']);
});

after(() => {
  closeAllSockets();
});

async function quoteAndCreateRide(client: HttpClient): Promise<http.CreateRideResponse> {
  const quote = (await client.request('quote', { body: { origin: ORIGIN, destination: DESTINATION } })) as http.QuoteResponse;
  return (await client.request('createRide', { body: { quoteId: quote.quoteId } })) as http.CreateRideResponse;
}

async function selectDriver(actors: RideActors, rideId: string): Promise<http.SelectDriverResponse> {
  return (await actors.client.request('selectDriver', {
    pathParams: { id: rideId },
    body: { driverId: actors.driverPublicId },
  })) as http.SelectDriverResponse;
}

// --- Scénario nominal (L10-01, étapes 1 à 9) ----------------------------------------------------

test('scénario nominal -- boucle complète, encaissement espèces', { timeout: 120_000 }, async () => {
  // 1-2. Chauffeur créé, approuvé, moto affectée (approveDriver), en ligne (bringDriverOnline).
  const actors = await setUpRideActors('nominal');

  // 3. Le client demande une estimation, crée la course.
  const ride = await quoteAndCreateRide(actors.client);

  // 4. Le client sélectionne le chauffeur.
  const proposed = await selectDriver(actors, ride.id);
  assert.equal(proposed.state, 'proposed', `select-driver : ${JSON.stringify(proposed)}`);
  assert.equal(await readRideState(ride.id), 'proposed');

  // 5. Le chauffeur accepte -- par le VRAI chemin temps réel (proposal.accept), jamais le canal
  // interne réservé au service temps réel lui-même.
  await acceptProposalOverWs(actors.driverSocket, ride.id);
  assert.equal(await readRideState(ride.id), 'assigned', 'acceptation par proposal.accept');

  // 6. Émission de positions, vérification du suivi côté client (ride.track / driver.position).
  sendPosition(actors.driverSocket, EN_ROUTE_POSITION);
  const tracked = await trackRideAndAwaitPosition(actors.clientSocket, ride.id);
  assert.equal(tracked.rideId, ride.id);
  assert.ok(Number.isFinite(tracked.position.latitude) && Number.isFinite(tracked.position.longitude));

  // 7. Démarrage puis fin de course.
  const started = (await actors.driverClient.request('startRide', { pathParams: { id: ride.id } })) as http.StartRideResponse;
  assert.equal(started.state, 'in_progress');
  const completed = (await actors.driverClient.request('completeRide', {
    pathParams: { id: ride.id },
    body: {},
  })) as http.CompleteRideResponse;
  assert.equal(completed.state, 'completed');

  // 8. Encaissement espèces.
  const settled = (await actors.driverClient.request('settleRide', {
    pathParams: { id: ride.id },
    body: { amountCollected: completed.amount },
  })) as http.SettleRideResponse;
  assert.equal(settled.state, 'settled');
  assert.equal(await readRideState(ride.id), 'settled');

  // 9. Vérification : facture générée, solde chauffeur incrémenté.
  // (« journal d'audit complet » n'est pas vérifiable aujourd'hui -- amoa/questions/L10-01.md.)
  const rideIds = await execute<number[]>('babana.ride', 'search', [[['public_id', '=', ride.id]]]);
  const [rideRecord] = await execute<{ invoice_id: [number, string] | false }[]>('babana.ride', 'read', [
    rideIds,
    ['invoice_id'],
  ]);
  assert.ok(rideRecord!.invoice_id, 'une facture (account.move) doit être liée à la course encaissée');

  const driverIds = await execute<number[]>('babana.driver', 'search', [[['public_id', '=', actors.driverPublicId]]]);
  const [driverRecord] = await execute<{ cash_balance: number }[]>('babana.driver', 'read', [driverIds, ['cash_balance']]);
  assert.ok(
    driverRecord!.cash_balance >= completed.amount,
    `solde chauffeur attendu >= ${completed.amount}, obtenu ${driverRecord!.cash_balance}`,
  );
});

// --- Variante : refus puis nouvelle sélection puis acceptation -----------------------------------

test('variante -- refus puis nouvelle sélection puis acceptation', { timeout: 120_000 }, async () => {
  const actors = await setUpRideActors('refus');
  const ride = await quoteAndCreateRide(actors.client);

  const firstProposal = await selectDriver(actors, ride.id);
  assert.equal(firstProposal.state, 'proposed');

  await rejectProposalOverWs(actors.driverSocket, ride.id, 'itinéraire trop long (scénario L10-01)');
  assert.equal(await readRideState(ride.id), 'rejected', 'un refus explicite doit reposer la course à «rejected»');

  // Une nouvelle sélection est le seul chemin de reprise (action_propose accepte 'requested' ET
  // 'rejected', babana_ride_state.py) -- même chauffeur ici, il redevient sélectionnable dès que
  // sa réservation précédente est relâchée (releaseDriver, ProposalLifecycle.reject()).
  await waitForDriverVisible(actors.clientSocket, actors.driverPublicId, ORIGIN);
  const secondProposal = await selectDriver(actors, ride.id);
  assert.equal(secondProposal.state, 'proposed', `deuxième sélection : ${JSON.stringify(secondProposal)}`);

  await acceptProposalOverWs(actors.driverSocket, ride.id);
  assert.equal(await readRideState(ride.id), 'assigned', 'acceptation après une seconde sélection');
});

// --- Variante : annulation par le client après affectation ---------------------------------------

test('variante -- annulation par le client après affectation', { timeout: 120_000 }, async () => {
  const actors = await setUpRideActors('annulation');
  const ride = await quoteAndCreateRide(actors.client);
  await selectDriver(actors, ride.id);

  await acceptProposalOverWs(actors.driverSocket, ride.id);
  assert.equal(await readRideState(ride.id), 'assigned');

  const cancelled = (await actors.client.request('cancelRide', {
    pathParams: { id: ride.id },
    body: { reason: 'changement de plan (scénario L10-01)' },
  })) as http.CancelRideResponse;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(await readRideState(ride.id), 'cancelled');

  // Le chauffeur redevient sélectionnable : sa réservation (D26) est relâchée par l'annulation,
  // même mécanisme que pour un refus -- la diffusion nearby.drivers périodique déjà en cours sur
  // clientSocket (toujours abonné) doit le remontrer sans nouvel abonnement.
  await waitForDriverVisible(actors.clientSocket, actors.driverPublicId, ORIGIN);
});

// --- Variante : franchissement du plafond d'encaisse, blocage, puis remise de caisse -------------

test(
  "variante -- franchissement du plafond d'encaisse, blocage, puis remise de caisse",
  { timeout: 120_000 },
  async () => {
    const actors = await setUpRideActors('plafond');

    // Même repli que CASH_LIMIT_PARAM côté modèle (babana_driver.py) -- get_param le retourne
    // déjà si la clé n'a jamais été posée, pas besoin de le deviner ici.
    const originalLimit = await execute<string>('ir.config_parameter', 'get_param', ['babana.cash_limit', '50000.0']);

    try {
      const ride = await quoteAndCreateRide(actors.client);
      await selectDriver(actors, ride.id);
      await acceptProposalOverWs(actors.driverSocket, ride.id);
      await actors.driverClient.request('startRide', { pathParams: { id: ride.id } });
      const completed = (await actors.driverClient.request('completeRide', {
        pathParams: { id: ride.id },
        body: {},
      })) as http.CompleteRideResponse;

      // Plafond posé SOUS le montant réellement dû (paramétrable, invariant 5) : un seul
      // encaissement le franchit alors à coup sûr, quelle que soit la grille tarifaire du jour.
      await execute('ir.config_parameter', 'set_param', ['babana.cash_limit', String(Math.max(1, completed.amount - 100))]);

      const settled = (await actors.driverClient.request('settleRide', {
        pathParams: { id: ride.id },
        body: { amountCollected: completed.amount },
      })) as http.SettleRideResponse;
      assert.equal(settled.cashLimitReached, true, "le plafond, posé sous le montant dû, doit être franchi (L5-02)");

      const driverIds = await execute<number[]>('babana.driver', 'search', [[['public_id', '=', actors.driverPublicId]]]);
      const [driverAfterBlock] = await execute<{ cash_limit_reached: boolean }[]>('babana.driver', 'read', [
        driverIds,
        ['cash_limit_reached'],
      ]);
      assert.equal(driverAfterBlock!.cash_limit_reached, true);

      // Point de blocage 1 (L5-02, critère 1) : un chauffeur au plafond n'apparaît plus dans
      // nearby.drivers -- attend l'ABSENCE plutôt que la présence (waitForDriverVisible rejette
      // après son délai si le chauffeur n'apparaît jamais, ce qui est le résultat attendu ici).
      await assert.rejects(
        waitForDriverVisible(actors.clientSocket, actors.driverPublicId, ORIGIN, { maxWaitMs: 12_000 }),
        /jamais apparu/,
        'un chauffeur au plafond ne doit plus apparaître dans nearby.drivers',
      );

      // Remise de caisse (L5-04) : le chauffeur déclare par le vrai endpoint mobile...
      const cash = (await actors.driverClient.request('driverCash')) as http.DriverCashResponse;
      const remittance = (await actors.driverClient.request('createRemittance', {
        body: { amount: cash.balance },
      })) as http.CreateRemittanceResponse;
      assert.equal(remittance.status, 'pending');

      // ...le superviseur compte et valide depuis le back-office (L5-04 : "flux back-office Odoo
      // natif, hors de ce contrat mobile" -- aucune route publique n'existe pour ce geste,
      // babana_cash_remittance.py::button_validate en est le seul chemin RPC-sûr, sans recordset
      // en argument).
      await ensureSupervisor();
      const [remittanceId] = await execute<number[]>('babana.cash.remittance', 'search', [
        [['public_id', '=', remittance.id]],
      ]);
      await execute('babana.cash.remittance', 'write', [[remittanceId], { counted_amount: cash.balance }]);
      await execute('babana.cash.remittance', 'button_validate', [[remittanceId]]);

      const [driverAfterRemittance] = await execute<{ cash_balance: number; cash_limit_reached: boolean }[]>(
        'babana.driver',
        'read',
        [driverIds, ['cash_balance', 'cash_limit_reached']],
      );
      assert.equal(driverAfterRemittance!.cash_balance, 0, 'une remise complète remet le solde à zéro (D8)');
      assert.equal(driverAfterRemittance!.cash_limit_reached, false, 'le chauffeur doit être débloqué (critère 5, L5-04)');

      // Débloqué : `unblockForCash` (cash-guard.ts) lève seulement le marqueur, sans réinsérer
      // dans le pool géographique -- c'est la PROCHAINE position émise qui GEOADD à nouveau
      // (pool-eligibility.lua). Un vrai chauffeur continue d'émettre ; ce test en provoque une
      // tout de suite plutôt que d'attendre le prochain rafraîchissement périodique (20 s,
      // bringDriverOnline) et de risquer de le manquer de peu.
      sendPosition(actors.driverSocket, ORIGIN);
      await waitForDriverVisible(actors.clientSocket, actors.driverPublicId, ORIGIN);
    } finally {
      // Ne pas laisser un plafond de test affecter les autres scénarios de ce fichier (exécutés
      // dans le même processus, sur la même base) ni une exécution ultérieure de test/http-contract.
      await execute('ir.config_parameter', 'set_param', ['babana.cash_limit', originalLimit]);
    }
  },
);

// --- Variante : notifications entièrement désactivées (L7-06) ------------------------------------
// Voir l'écart en tête de fichier et amoa/questions/L10-01.md : aucun jeton d'appareil n'est
// jamais enregistré pour ces deux acteurs (aucun canal de notification n'existe alors pour eux),
// et le mécanisme réel de récupération d'état (`session.resync`, L3-11 -- déjà exercé par le test
// de résilience L3-14) est exercé explicitement après une reconnexion, pour prouver que l'état de
// la course reste retrouvable sans qu'aucune notification n'ait jamais dû être livrée.

test('variante -- notifications entièrement désactivées : la boucle reste réalisable', { timeout: 120_000 }, async () => {
  const actors = await setUpRideActors('no-push');
  const ride = await quoteAndCreateRide(actors.client);
  await selectDriver(actors, ride.id);

  await acceptProposalOverWs(actors.driverSocket, ride.id);
  assert.equal(await readRideState(ride.id), 'assigned');

  // Simule une reconnexion (app rouverte, ou perte de connexion réseau intermittente, CLAUDE.md)
  // -- jamais une notification pour l'annoncer : la reconnexion elle-même déclenche
  // session.resync (L3-11), qui doit retrouver la course en cours depuis Odoo, pas depuis un état
  // en mémoire perdu à la fermeture de la connexion précédente.
  actors.driverSocket.close();
  const freshDriverSocket = await bringDriverOnline(actors.driverSession.accessToken, ORIGIN);
  const synced = await resync(freshDriverSocket, null);
  assert.equal(synced.rideStateKnown, true, 'session.resync doit retrouver la course sans notification');
  assert.equal(synced.activeRideId, ride.id);
  assert.equal(synced.activeRideState, 'assigned');

  // La suite de la boucle ne dépend d'aucun canal de notification (start/complete/settle sont de
  // purs appels HTTP, jamais un message WS) -- elle doit aboutir identiquement.
  await actors.driverClient.request('startRide', { pathParams: { id: ride.id } });
  const completed = (await actors.driverClient.request('completeRide', {
    pathParams: { id: ride.id },
    body: {},
  })) as http.CompleteRideResponse;
  const settled = (await actors.driverClient.request('settleRide', {
    pathParams: { id: ride.id },
    body: { amountCollected: completed.amount },
  })) as http.SettleRideResponse;
  assert.equal(settled.state, 'settled', 'la boucle complète reste réalisable sans aucune notification livrée');

  freshDriverSocket.close();
});
