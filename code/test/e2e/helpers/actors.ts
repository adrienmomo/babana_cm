// L10-01 -- prépare les acteurs d'un scénario de bout en bout par le VRAI chemin (spécification :
// "les apps mobiles ne sont pas pilotées : le test appelle les API et les WebSocket
// directement"). Réutilise ce qui existe déjà plutôt que de le redupliquer (CLAUDE.md, "pas de
// dépendance nouvelle sans nécessité") : la création/authentification/approbation d'un chauffeur
// (test/concurrency/helpers/odoo-session.ts) et le câblage temps réel réel -- connexion WS
// persistante, abonnement nearby, acceptation par `proposal.accept` (test/concurrency/helpers/
// realtime.ts). Ce fichier n'ajoute que ce qu'aucun des deux ne porte déjà : le VRAI client HTTP
// du contrat (`@babana/api-client`, comme test/http-contract), le refus `proposal.reject`, la
// bascule superviseur pour la remise de caisse (L5-04), et le suivi `ride.track`.
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { createHttpClient } from '@babana/api-client/dist/http';
import {
  ODOO_HTTP_ROOT,
  execute,
  signIn,
  approveDriver,
  Session,
} from '../../concurrency/helpers/odoo-session';
import { bringDriverOnline, openClientSubscription, waitForDriverVisible, seedDriverProfile } from '../../concurrency/helpers/realtime';
import { ORIGIN } from '../fixtures/geo';

export type HttpClient = ReturnType<typeof createHttpClient>;

export function clientFor(accessToken: string): HttpClient {
  return createHttpClient({ baseUrl: ODOO_HTTP_ROOT, fetchImpl: fetch, getAccessToken: () => accessToken });
}

export function uniqueSub(label: string): string {
  return `sub-e2e-${label}-${randomUUID()}`;
}

export interface RideActors {
  label: string;
  clientSession: Session;
  driverSession: Session;
  driverPublicId: string;
  client: HttpClient;
  driverClient: HttpClient;
  clientSocket: WebSocket;
  driverSocket: WebSocket;
}

const openSockets = new Set<WebSocket>();

/** Ferme toutes les connexions ouvertes par ce fichier -- à appeler depuis le `after()` de chaque
 * fichier de test qui utilise ces fixtures (même discipline que test/concurrency/
 * ride-transitions.test.ts). */
export function closeAllSockets(): void {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
}

/** Client + chauffeur réellement authentifiés (vrai /auth/google -> mock-google-identity, D19),
 * chauffeur approuvé (documents vérifiés, moto affectée -- L10-01 étape 1), en ligne et
 * réellement visible de CE client (précondition C-03, L3-17 -- étape 2). Connexions laissées
 * ouvertes : l'appelant les ferme via `closeAllSockets()` en fin de fichier. */
export async function setUpRideActors(label: string, position = ORIGIN): Promise<RideActors> {
  const clientSession = await signIn(uniqueSub(`${label}-client`), 'client');
  const driverSession = await signIn(uniqueSub(`${label}-driver`), 'driver');
  const { driverPublicId } = await approveDriver(driverSession, label);
  const driverClient = clientFor(driverSession.accessToken);

  // Deux signaux INDÉPENDANTS, délibérément découplés (babana_driver.py::
  // _babana_apply_cash_limit, commentaire : "le service temps réel garde son propre état... ,
  // indépendant d'is_online") : `POST /drivers/me/availability` pose `babana.driver.is_online`
  // côté Odoo -- lu par le franchissement du plafond d'encaisse (L5-02) et par l'éligibilité de
  // mise en ligne -- tandis que `availability.set` (WS, bringDriverOnline ci-dessous) entre le
  // chauffeur dans le pool géo-indexé du service temps réel. Un vrai chauffeur en ligne déclenche
  // les deux ; test/concurrency n'a jamais eu besoin du premier (ses scénarios ne lisent jamais
  // is_online), ce qui a caché l'absence de cet appel jusqu'à ce que le scénario du plafond
  // d'encaisse (L10-01) le révèle : `_babana_apply_cash_limit` ne détecte JAMAIS un franchissement
  // pour un chauffeur dont `is_online` est resté à `False`.
  await driverClient.request('setAvailability', { body: { online: true } });

  const driverSocket = await bringDriverOnline(driverSession.accessToken, position);
  await seedDriverProfile(driverPublicId, `Chauffeur ${label}`);
  const clientSocket = await openClientSubscription(clientSession.accessToken, position);
  await waitForDriverVisible(clientSocket, driverPublicId, position);
  openSockets.add(driverSocket).add(clientSocket);

  return {
    label,
    clientSession,
    driverSession,
    driverPublicId,
    client: clientFor(clientSession.accessToken),
    driverClient,
    clientSocket,
    driverSocket,
  };
}

function envelope(type: string, payload: unknown) {
  return { type, id: randomUUID(), emittedAt: new Date().toISOString(), payload };
}

/** Refuse une proposition par le VRAI chemin temps réel (`proposal.reject`, symétrique de
 * `acceptProposalOverWs` de test/concurrency/helpers/realtime.ts, qui n'a pas son pendant refus).
 * Après résolution, la course repasse à 'rejected' -- `action_propose`
 * (babana_ride_state.py) accepte aussi bien 'requested' que 'rejected' comme état de départ :
 * une nouvelle sélection (même chauffeur ou un autre) est donc le seul chemin de reprise, jamais
 * un nouvel endpoint. */
export async function rejectProposalOverWs(driverSocket: WebSocket, rideId: string, reason: string): Promise<void> {
  driverSocket.send(JSON.stringify(envelope('proposal.reject', { rideId, reason })));
  // Même délai que acceptProposalOverWs -- laisse le serveur résoudre (Redis, puis l'appel
  // interne vers /driver-rejected) avant de continuer.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export interface DriverPositionUpdate {
  rideId: string;
  position: { latitude: number; longitude: number };
  etaSeconds: number;
}

/** Abonne le client au suivi d'une course (`ride.track`, L3-09) et attend UNE diffusion
 * `driver.position` -- la preuve de suivi que L10-01 demande à l'étape 6. Attend d'abord
 * `ride.track.ack` (porte la cadence réelle de diffusion, D50) plutôt que de deviner un délai :
 * même discipline que `waitForDriverVisible` (jamais supposer quelle trame arrive ensuite, C-02).
 */
export async function trackRideAndAwaitPosition(clientSocket: WebSocket, rideId: string): Promise<DriverPositionUpdate> {
  const broadcastIntervalMs = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ride.track.ack jamais reçu')), 10_000);
    const onAck = (data: WebSocket.RawData) => {
      let message: { type?: string; payload?: { broadcastIntervalMs?: number } };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type !== 'ride.track.ack') return;
      clearTimeout(timer);
      clientSocket.off('message', onAck);
      resolve(message.payload?.broadcastIntervalMs ?? 5_000);
    };
    clientSocket.on('message', onAck);
    clientSocket.send(JSON.stringify(envelope('ride.track', { rideId })));
  });

  return new Promise<DriverPositionUpdate>((resolve, reject) => {
    // Large marge sur la cadence annoncée : environnement de test partagé, pas un temps réel
    // strict (même raisonnement que DEFAULT_VISIBILITY_WAIT_MS, realtime.ts).
    const maxWaitMs = broadcastIntervalMs * 4 + 10_000;
    const timer = setTimeout(
      () => reject(new Error(`aucune diffusion driver.position reçue après ${maxWaitMs}ms`)),
      maxWaitMs,
    );
    const onMessage = (data: WebSocket.RawData) => {
      let message: { type?: string; payload?: DriverPositionUpdate };
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type !== 'driver.position' || message.payload?.rideId !== rideId) return;
      clearTimeout(timer);
      clientSocket.off('message', onMessage);
      resolve(message.payload!);
    };
    clientSocket.on('message', onMessage);
  });
}

let supervisorEnsured = false;

/** Ajoute l'admin technique (celui que `execute()` utilise déjà, odoo-session.ts::adminUid) au
 * groupe `group_babana_supervisor` -- idempotent, même patron que adminUid() pour
 * group_babana_admin. Nécessaire pour `babana.cash.remittance::button_validate` (L5-04) : "pas de
 * sudo() : l'appartenance à group_babana_supervisor est ce qui autorise l'écriture". Un groupe
 * séparé de group_babana_admin (déjà acquis par execute()) : les deux sont des habilitations
 * indépendantes (L8-01/L8-02), un administrateur technique n'est pas superviseur par défaut. */
export async function ensureSupervisor(): Promise<void> {
  if (supervisorEnsured) return;
  const [groupDataRecord] = await execute<{ res_id: number }[]>('ir.model.data', 'search_read', [
    [['module', '=', 'babana'], ['name', '=', 'group_babana_supervisor']],
    ['res_id'],
  ]);
  const groupId = groupDataRecord!.res_id;
  // Même repli que ODOO_ADMIN_LOGIN dans odoo-session.ts (non exporté) : execute() authentifie
  // toujours ce même identifiant -- retrouver le uid par ce login, plutôt que d'exporter l'uid
  // caché de odoo-session.ts pour ce seul usage.
  const adminLogin = process.env.ODOO_ADMIN_LOGIN ?? 'admin';
  const [adminUserId] = await execute<number[]>('res.users', 'search', [[['login', '=', adminLogin]]]);
  await execute('res.users', 'write', [[adminUserId], { groups_id: [[4, groupId]] }]);
  supervisorEnsured = true;
}
