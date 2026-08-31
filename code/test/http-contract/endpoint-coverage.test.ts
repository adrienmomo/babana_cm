// C-01, critère d'acceptation 6 (ajouté le 25 août, amoa/questions/C-01.md) : chaque endpoint du
// contrat appelé contre le VRAI Odoo, sa réponse validée par son PROPRE schéma de réponse -- pas
// une réponse fabriquée par le test. C'est le trou qui a laissé passer six semaines un défaut
// faisant échouer toute commande de course (C-01R, amoa/questions/C-01.md) : les tests d'écran
// simulent le client HTTP (apps/client/src/screens/__tests__), les tests de packages/api-client
// construisent eux-mêmes des réponses déjà bien formées, et test/concurrency parle en `fetch` brut
// sans jamais passer par `endpoint.responseSchema.parse`. Trois suites vertes, aucune n'exerçait
// le seul assemblage qui compte : le vrai serveur, le vrai `@babana/api-client`, la vraie
// validation -- exactement ce que ce fichier fait, endpoint par endpoint.
//
// La liste des endpoints à couvrir se DÉRIVE du contrat (`http.HTTP_ENDPOINTS`), jamais tenue à
// la main -- même discipline que la machine à états générée (L4-10,
// services/odoo/addons/babana/tests/test_ride_state_machine_generated.py) et la matrice
// d'habilitations (L8-02) : la vérification de complétude ci-dessous fait échouer ce fichier au
// CHARGEMENT si un endpoint du contrat n'a ni fonction d'exercice réelle, ni exclusion
// documentée -- pas de silence possible, dans un sens comme dans l'autre.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { http } from '@babana/contracts';
// Sous-chemin explicite, pas l'entrée principale du paquet : `@babana/api-client` réexporte
// aussi ./auth (session, stockage du jeton via react-native-keychain) et ./realtime, tous deux
// pensés pour le bundler Metro (React Native) -- Flow, pas TypeScript pur -- qu'esbuild (tsx)
// ne sait pas transformer hors de ce contexte. Ce fichier n'a besoin que du client HTTP
// générique ; aucun "exports" dans packages/api-client/package.json ne restreint ce sous-chemin.
import { createHttpClient } from '@babana/api-client/dist/http';
import {
  ODOO_API_ROOT,
  ODOO_HTTP_ROOT,
  mintGoogleToken,
  approveDriver,
  callInternalEndpoint,
} from '../concurrency/helpers/odoo-session';
import { bringDriverOnline, makeDriverVisibleToClient } from './helpers/realtime-ws';

type EndpointName = keyof typeof http.HTTP_ENDPOINTS;
type HttpClient = ReturnType<typeof createHttpClient>;

const ORIGIN = { latitude: 4.05, longitude: 9.7 };
const DESTINATION = { latitude: 4.06, longitude: 9.71 };

// baseUrl est la racine du domaine, PAS ODOO_API_ROOT (qui inclut déjà /api/v1) : chaque chemin
// de HTTP_ENDPOINTS est déjà préfixé de /api/v1 (voir packages/contracts/src/http/index.ts) --
// même convention que la doc de ApiClientConfig ("https://api.babana.cm", ApiClientConfig,
// packages/api-client/src/http/client.ts).
function anonymousClient(): HttpClient {
  return createHttpClient({ baseUrl: ODOO_HTTP_ROOT, fetchImpl: fetch });
}

function clientFor(accessToken: string): HttpClient {
  return createHttpClient({ baseUrl: ODOO_HTTP_ROOT, fetchImpl: fetch, getAccessToken: () => accessToken });
}

/** Sign-in réel à travers le vrai `@babana/api-client` (contrairement à
 * `../concurrency/helpers/odoo-session.ts::signIn`, qui parle en `fetch` brut -- suffisant pour
 * de simples fixtures, pas pour exercer authGoogle lui-même). Sert de fixture à tout endpoint
 * authentifié ci-dessous ET constitue, à lui seul, l'exercice de authGoogle. */
async function freshSession(role: 'client' | 'driver', label: string): Promise<http.GoogleAuthResponse> {
  const sub = `contract-${label}-${randomUUID()}`;
  const idToken = await mintGoogleToken(sub, `${sub}@example.invalid`);
  return (await anonymousClient().request('authGoogle', { body: { idToken, role } })) as http.GoogleAuthResponse;
}

async function approvedDriverSession(label: string): Promise<{ session: http.GoogleAuthResponse; driverPublicId: string }> {
  const session = await freshSession('driver', label);
  const { driverPublicId } = await approveDriver({ accessToken: session.accessToken, publicUserId: session.user.id }, label);
  return { session, driverPublicId };
}

interface ProposedRide {
  client: HttpClient;
  clientSession: http.GoogleAuthResponse;
  driverSession: http.GoogleAuthResponse;
  driverPublicId: string;
  ride: http.SelectDriverResponse;
}

/** Course réellement proposée (requested -> proposed) : chauffeur réellement en ligne,
 * positionné et montré au client (précondition C-03, L3-17) -- sans ce dernier point,
 * select-driver renverrait DRIVER_ALREADY_TAKEN pour un chauffeur pourtant disponible
 * (amoa/questions/L3-17.md §3). */
async function setupProposedRide(label: string): Promise<ProposedRide> {
  const clientSession = await freshSession('client', `${label}-client`);
  const { session: driverSession, driverPublicId } = await approvedDriverSession(`${label}-driver`);
  await bringDriverOnline(driverSession.accessToken, ORIGIN);
  await makeDriverVisibleToClient(clientSession.accessToken, driverPublicId, ORIGIN);

  const client = clientFor(clientSession.accessToken);
  const quote = (await client.request('quote', { body: { origin: ORIGIN, destination: DESTINATION } })) as http.QuoteResponse;
  const created = (await client.request('createRide', { body: { quoteId: quote.quoteId } })) as http.CreateRideResponse;
  const proposed = (await client.request('selectDriver', {
    pathParams: { id: created.id },
    body: { driverId: driverPublicId },
  })) as http.SelectDriverResponse;

  return { client, clientSession, driverSession, driverPublicId, ride: proposed };
}

/** Course affectée (proposed -> assigned), par le seul chemin d'écriture réel (D31) : le canal
 * interne, comme le ferait le service temps réel après une acceptation résolue atomiquement --
 * jamais un second chemin HTTP public qui ignorerait la réservation. */
async function setupAssignedRide(label: string): Promise<ProposedRide> {
  const rig = await setupProposedRide(label);
  const accept = await callInternalEndpoint(`/api/internal/rides/${rig.ride.id}/driver-accepted`, {
    driverId: rig.driverPublicId,
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  return rig;
}

// --- Endpoints non implémentés aujourd'hui, avec la raison et la tâche qui les couvrira --------
// Documenté, jamais silencieux (CLAUDE.md, protocole d'écart). Vérifié par grep avant d'écrire
// cette liste (pas supposé, CLAUDE.md "une dépendance supposée absente se vérifie dans le
// dépôt") : aucune de ces routes n'existe dans services/odoo/addons/babana/controllers/*.py ni
// dans services/realtime/src -- voir la vérification exécutable ci-dessous (chacune doit encore
// répondre 404 aujourd'hui, sans quoi ce fichier n'a pas été mis à jour avec le code).
const NOT_YET_IMPLEMENTED: Partial<Record<EndpointName, string>> = {
  rateRide: 'babana.rating absent (L4-09, hors périmètre à ce jour -- controllers/ride.py en tête de fichier le documente déjà).',
  phoneVerifyStart: "aucun controllers/phone.py -- endpoint jamais câblé côté Odoo (L1-xx, hors périmètre à ce jour).",
  phoneVerifyConfirm: 'idem phoneVerifyStart.',
};

const EXERCISES: Partial<Record<EndpointName, () => Promise<void>>> = {
  authGoogle: async () => {
    const session = await freshSession('client', 'auth-google');
    assert.equal(session.user.role, 'client');
    assert.equal(session.user.phoneVerified, false);
  },

  authRefresh: async () => {
    const session = await freshSession('client', 'auth-refresh');
    const refreshed = (await anonymousClient().request('authRefresh', {
      body: { refreshToken: session.refreshToken },
    })) as http.RefreshResponse;
    assert.ok(refreshed.accessToken.length > 0);
    assert.notEqual(refreshed.refreshToken, session.refreshToken, 'rotation attendue (L1-02)');
  },

  authLogout: async () => {
    const session = await freshSession('client', 'auth-logout');
    const result = (await anonymousClient().request('authLogout', {
      body: { refreshToken: session.refreshToken },
    })) as http.LogoutResponse;
    assert.equal(result.revoked, true);
  },

  me: async () => {
    const session = await freshSession('client', 'me');
    const me = (await clientFor(session.accessToken).request('me')) as http.MeResponse;
    assert.equal(me.id, session.user.id);
  },

  quote: async () => {
    const session = await freshSession('client', 'quote');
    const quote = (await clientFor(session.accessToken).request('quote', {
      body: { origin: ORIGIN, destination: DESTINATION },
    })) as http.QuoteResponse;
    assert.ok(quote.quoteId);
    assert.ok(quote.expiresAt);
  },

  createRide: async () => {
    const session = await freshSession('client', 'create-ride');
    const client = clientFor(session.accessToken);
    const quote = (await client.request('quote', { body: { origin: ORIGIN, destination: DESTINATION } })) as http.QuoteResponse;
    const ride = (await client.request('createRide', { body: { quoteId: quote.quoteId } })) as http.CreateRideResponse;
    assert.equal(ride.state, 'requested');
  },

  selectDriver: async () => {
    const rig = await setupProposedRide('select-driver');
    assert.equal(rig.ride.state, 'proposed');
    assert.equal(rig.ride.assignedDriverId, rig.driverPublicId);
  },

  startRide: async () => {
    const rig = await setupAssignedRide('start-ride');
    const started = (await clientFor(rig.driverSession.accessToken).request('startRide', {
      pathParams: { id: rig.ride.id },
    })) as http.StartRideResponse;
    assert.equal(started.state, 'in_progress');
  },

  completeRide: async () => {
    const rig = await setupAssignedRide('complete-ride');
    const driverClient = clientFor(rig.driverSession.accessToken);
    await driverClient.request('startRide', { pathParams: { id: rig.ride.id } });
    // J24 (amoa/questions/L6-13.md) : la fin de course ne porte que la décision -- corps vide.
    const completed = (await driverClient.request('completeRide', {
      pathParams: { id: rig.ride.id },
      body: {},
    })) as http.CompleteRideResponse;
    assert.equal(completed.state, 'completed');
  },

  settleRide: async () => {
    const rig = await setupAssignedRide('settle-ride');
    const driverClient = clientFor(rig.driverSession.accessToken);
    await driverClient.request('startRide', { pathParams: { id: rig.ride.id } });
    const completed = (await driverClient.request('completeRide', {
      pathParams: { id: rig.ride.id },
      body: {},
    })) as http.CompleteRideResponse;
    const settled = (await driverClient.request('settleRide', {
      pathParams: { id: rig.ride.id },
      body: { amountCollected: completed.amount },
    })) as http.SettleRideResponse;
    assert.equal(settled.state, 'settled');
  },

  cancelRide: async () => {
    const session = await freshSession('client', 'cancel-ride');
    const client = clientFor(session.accessToken);
    const quote = (await client.request('quote', { body: { origin: ORIGIN, destination: DESTINATION } })) as http.QuoteResponse;
    const ride = (await client.request('createRide', { body: { quoteId: quote.quoteId } })) as http.CreateRideResponse;
    const cancelled = (await client.request('cancelRide', {
      pathParams: { id: ride.id },
      body: { reason: 'C-01 critère 6 -- exercice de contrat' },
    })) as http.CancelRideResponse;
    assert.equal(cancelled.state, 'cancelled');
  },

  triggerIncident: async () => {
    const rig = await setupAssignedRide('trigger-incident');
    const triggered = (await rig.client.request('triggerIncident', {
      pathParams: { id: rig.ride.id },
      body: { latitude: 4.05, longitude: 9.7, triggeredAt: new Date().toISOString() },
    })) as http.TriggerIncidentResponse;
    assert.equal(triggered.status, 'open');
  },

  createRideShare: async () => {
    const rig = await setupAssignedRide('create-ride-share');
    const share = (await rig.client.request('createRideShare', {
      pathParams: { id: rig.ride.id },
    })) as http.CreateRideShareResponse;
    assert.ok(share.token.length > 0);
    assert.ok(share.url.includes(share.token));
  },

  revokeRideShare: async () => {
    const rig = await setupAssignedRide('revoke-ride-share');
    await rig.client.request('createRideShare', { pathParams: { id: rig.ride.id } });
    const revoked = (await rig.client.request('revokeRideShare', {
      pathParams: { id: rig.ride.id },
    })) as http.RevokeRideShareResponse;
    assert.equal(revoked.revoked, true);
  },

  setAvailability: async () => {
    const { session } = await approvedDriverSession('set-availability');
    const client = clientFor(session.accessToken);
    const online = (await client.request('setAvailability', { body: { online: true } })) as http.SetAvailabilityResponse;
    assert.equal(online.online, true);
    const offline = (await client.request('setAvailability', { body: { online: false } })) as http.SetAvailabilityResponse;
    assert.equal(offline.online, false);
  },

  registerDeviceToken: async () => {
    const session = await freshSession('client', 'register-device');
    const client = clientFor(session.accessToken);
    const first = (await client.request('registerDeviceToken', {
      body: { token: `fcm-${randomUUID()}`, platform: 'android' },
    })) as http.RegisterDeviceTokenResponse;
    assert.equal(first.registered, true);
    // Additif : un second appareil pour le même compte n'écrase pas le premier (L7-01).
    const second = (await client.request('registerDeviceToken', {
      body: { token: `fcm-${randomUUID()}`, platform: 'ios' },
    })) as http.RegisterDeviceTokenResponse;
    assert.equal(second.registered, true);
  },

  deactivateDeviceToken: async () => {
    const session = await freshSession('client', 'deactivate-device');
    const client = clientFor(session.accessToken);
    const token = `fcm-${randomUUID()}`;
    await client.request('registerDeviceToken', { body: { token, platform: 'android' } });
    const deactivated = (await client.request('deactivateDeviceToken', {
      body: { token },
    })) as http.DeactivateDeviceTokenResponse;
    assert.equal(deactivated.deactivated, true);
  },

  driverCash: async () => {
    const { session } = await approvedDriverSession('driver-cash');
    const cash = (await clientFor(session.accessToken).request('driverCash')) as http.DriverCashResponse;
    assert.equal(typeof cash.balance, 'number');
    assert.equal(typeof cash.limit, 'number');
  },

  createRemittance: async () => {
    const { session } = await approvedDriverSession('remittance');
    const remittance = (await clientFor(session.accessToken).request('createRemittance', {
      body: { amount: 500 },
    })) as http.CreateRemittanceResponse;
    assert.equal(remittance.status, 'pending');
  },

  // multipart/form-data, pas un corps JSON (voir packages/contracts/src/http/documents.ts,
  // tête de fichier) : createHttpClient ne le sait pas faire (`attemptOnce` sérialise toujours en
  // JSON avec Content-Type: application/json). Seul cas de ce fichier qui parle en `fetch` brut
  // -- documenté explicitement, pas un oubli -- puis valide la réponse avec le MÊME schéma que le
  // contrat exporte, exactement ce que critère 6 demande même hors du client générique.
  uploadDriverDocument: async () => {
    const { session } = await approvedDriverSession('upload-document');
    const response = await fetch(`${ODOO_API_ROOT}/driver/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: uploadableDocumentForm(),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    const parsed = http.UploadDriverDocumentResponseSchema.parse(body);
    assert.equal(parsed.documentType, 'id_card');
  },

  listDriverDocuments: async () => {
    const { session } = await approvedDriverSession('list-documents');
    await fetch(`${ODOO_API_ROOT}/driver/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: uploadableDocumentForm(),
    });
    const listed = (await clientFor(session.accessToken).request('listDriverDocuments')) as http.ListDriverDocumentsResponse;
    assert.ok(Array.isArray(listed.documents));
    assert.ok(listed.documents.some((d) => d.documentType === 'id_card'));
  },

  driverDocumentSignedUrl: async () => {
    const { session } = await approvedDriverSession('document-signed-url');
    const uploadResponse = await fetch(`${ODOO_API_ROOT}/driver/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      body: uploadableDocumentForm(),
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 201, JSON.stringify(uploadBody));
    const uploaded = http.UploadDriverDocumentResponseSchema.parse(uploadBody);

    const signed = (await clientFor(session.accessToken).request('driverDocumentSignedUrl', {
      pathParams: { id: String(uploaded.id) },
    })) as http.DriverDocumentSignedUrlResponse;
    assert.ok(signed.url.startsWith('http'));
    assert.ok(signed.expiresIn > 0);
  },
};

/** JPEG minimal (en-tête magique seul, `services/storage.py::sniff_mime_type` ne lit que ça) --
 * un fichier réel, pas un texte déguisé : le contrôleur vérifie le type MIME réel, pas seulement
 * l'extension (critère 4 de L1-05). */
function uploadableDocumentForm(): FormData {
  const jpegMagicBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const form = new FormData();
  form.set('documentType', 'id_card');
  form.set('contentType', 'image/jpeg');
  form.set('file', new Blob([jpegMagicBytes], { type: 'image/jpeg' }), 'piece.jpg');
  return form;
}

// --- Vérification de complétude (critère 6) -----------------------------------------------
// Toute clé de HTTP_ENDPOINTS doit apparaître ici, soit dans EXERCISES, soit dans
// NOT_YET_IMPLEMENTED -- jamais dans aucun des deux (silencieusement oublié), jamais dans les
// deux (contradiction). Échoue au CHARGEMENT du module, avant qu'un seul test ne s'exécute --
// comme _ACTION_BY_TRANSITION le fait pour L4-10.
for (const name of Object.keys(http.HTTP_ENDPOINTS) as EndpointName[]) {
  const exercised = name in EXERCISES;
  const excluded = name in NOT_YET_IMPLEMENTED;
  if (!exercised && !excluded) {
    throw new Error(
      `C-01, critère 6 : l'endpoint "${name}" n'a ni fonction d'exercice (EXERCISES) ni exclusion ` +
        'documentée (NOT_YET_IMPLEMENTED) dans test/http-contract/endpoint-coverage.test.ts. Un ' +
        "endpoint ajouté au contrat sans son test doit faire échouer cette suite -- c'est ce qui " +
        'vient de se produire, à corriger avant de fusionner.'
    );
  }
  if (exercised && excluded) {
    throw new Error(`C-01, critère 6 : "${name}" est à la fois exercé et exclu -- contradiction à résoudre.`);
  }
}

describe('C-01 critère 6 -- chaque endpoint appelé contre le vrai Odoo, réponse validée par son propre schéma', () => {
  for (const [name, exercise] of Object.entries(EXERCISES) as [EndpointName, () => Promise<void>][]) {
    test(name, exercise);
  }

  describe('endpoints non implémentés -- exclusion documentée, vérifiée plutôt que supposée', () => {
    for (const [name, reason] of Object.entries(NOT_YET_IMPLEMENTED) as [EndpointName, string][]) {
      test(`${name} : ${reason}`, async () => {
        const descriptor = http.HTTP_ENDPOINTS[name];
        const path = descriptor.path.replace('{id}', randomUUID());
        const response = await fetch(`${ODOO_HTTP_ROOT}${path}`, { method: descriptor.method });
        // 404 aujourd'hui : si ce n'est plus vrai, l'endpoint a été implémenté sans que cette
        // liste n'ait été mise à jour -- la suite doit le signaler, pas le passer sous silence.
        assert.equal(
          response.status,
          404,
          `"${name}" ne répond plus 404 -- retirer son entrée de NOT_YET_IMPLEMENTED et lui ` +
            'écrire une fonction dans EXERCISES (C-01, critère 6).'
        );
      });
    }
  });
});
