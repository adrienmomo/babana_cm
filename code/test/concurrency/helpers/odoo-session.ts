// Sessions et appels contre la pile réelle démarrée par `make up` (L4-11). Aucun module Odoo
// n'est importé ici : tout passe par le JSON-RPC externe d'Odoo (fixtures : création de
// documents, approbation du chauffeur -- des méthodes à arguments simples, sûres en RPC) et par
// l'API mobile HTTP réelle pour les transitions elles-mêmes (select-driver, accept, cancel) --
// ce sont les seules qui prennent des recordsets en argument côté Python
// (babana_ride_state.py), donc pas RPC-safe telles quelles. C'est précisément pourquoi ce test
// vient après L4-03 cette nuit et non avant (voir le message de commit de ce lot).
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnvFile(relativePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path.resolve(__dirname, relativePath), 'utf8');
  } catch {
    return result;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

// infra/env/.env n'existe qu'après le premier `make up` (copié depuis .env.example -- voir
// Makefile) ; .env.example sert de repli pour lire au moins GOOGLE_OAUTH_CLIENT_IDS en
// développement, une valeur simulée (D19), jamais un secret.
const ENV_FILE = loadEnvFile('../../../infra/env/.env');
const ENV_EXAMPLE = loadEnvFile('../../../infra/env/.env.example');

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? ENV_FILE[name] ?? ENV_EXAMPLE[name] ?? fallback;
  if (value === undefined) {
    throw new Error(
      `variable d'environnement ${name} introuvable (environnement réel, infra/env/.env, ou infra/env/.env.example)`,
    );
  }
  return value;
}

// Ports publiés directement par infra/compose.yaml -- pas par Caddy (TLS auto-signé pour
// api.localhost, inutile pour un test qui parle au conteneur odoo directement). Même chemin
// d'accès que celui documenté par `make up` pour Odoo lui-même (http://localhost:8069).
export const ODOO_HTTP_ROOT = process.env.ODOO_HTTP_ROOT ?? 'http://localhost:8069';
export const ODOO_API_ROOT = `${ODOO_HTTP_ROOT}/api/v1`;
export const MOCK_GOOGLE_URL = process.env.GOOGLE_MOCK_IDENTITY_URL ?? 'http://localhost:4000';

const ODOO_DB = env('ODOO_DB', 'babana');
const ODOO_ADMIN_LOGIN = env('ODOO_ADMIN_LOGIN', 'admin');
// ADMIN_PASSWORD (infra/env/.env.example), pas ODOO_ADMIN_PASSWORD : c'est le nom que pose
// __init__.py::_post_init_admin_password sur le compte admin (D43 retournée, constat du 2
// septembre -- ce fichier tourne sur l'hôte, jamais dans un conteneur, et lisait jusqu'ici un
// nom de variable que rien ne posait, repliant silencieusement sur l'ancien défaut Odoo
// « admin » -- correct par coïncidence tant que ce mot de passe n'avait jamais été changé).
const ODOO_ADMIN_PASSWORD = env('ADMIN_PASSWORD', 'admin');

let requestId = 1;

async function jsonRpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
  const response = await fetch(`${ODOO_HTTP_ROOT}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: requestId++, params: { service, method, args } }),
  });
  const payload = (await response.json()) as { result?: T; error?: { data?: { message?: string }; message?: string } };
  if (payload.error) {
    throw new Error(`Odoo JSON-RPC ${service}.${method} : ${payload.error.data?.message ?? payload.error.message}`);
  }
  return payload.result as T;
}

let cachedAdminUid: number | undefined;
let adminGroupEnsured = false;

async function adminUid(): Promise<number> {
  if (cachedAdminUid === undefined) {
    cachedAdminUid = await jsonRpc<number>('common', 'login', [ODOO_DB, ODOO_ADMIN_LOGIN, ODOO_ADMIN_PASSWORD]);
  }
  if (!adminGroupEnsured) {
    // L'utilisateur "admin" (uid technique 2, voir amoa/rapport-nuit.md) est administrateur
    // Odoo mais n'appartient à aucun groupe métier babana par défaut (security/
    // babana_groups.xml : "les utilisateurs mobiles n'appartiennent à aucun de ces trois
    // groupes", et rien ne les attribue au compte de démo non plus). Les fixtures RPC de ce
    // fichier (documents, moto, action_approve) ont besoin de group_babana_admin -- l'ajouter
    // une fois, idempotent (write sur un groupe déjà présent ne fait rien).
    const [groupDataRecord] = await jsonRpc<{ res_id: number }[]>('object', 'execute_kw', [
      ODOO_DB,
      cachedAdminUid,
      ODOO_ADMIN_PASSWORD,
      'ir.model.data',
      'search_read',
      [[['module', '=', 'babana'], ['name', '=', 'group_babana_admin']], ['res_id']],
    ]);
    const groupId = groupDataRecord!.res_id;
    await jsonRpc('object', 'execute_kw', [
      ODOO_DB,
      cachedAdminUid,
      ODOO_ADMIN_PASSWORD,
      'res.users',
      'write',
      [[cachedAdminUid], { groups_id: [[4, groupId]] }],
    ]);
    adminGroupEnsured = true;
  }
  return cachedAdminUid;
}

/**
 * Appel générique execute_kw (fixtures uniquement -- create/write/search et les méthodes dont
 * les arguments sont des primitives, jamais les méthodes de transition de babana.ride).
 */
export async function execute<T = unknown>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const uid = await adminUid();
  return jsonRpc<T>('object', 'execute_kw', [ODOO_DB, uid, ODOO_ADMIN_PASSWORD, model, method, args, kwargs]);
}

/** Exporté pour test/http-contract (C-01, critère 6) : ce fichier a besoin d'un ID token Google
 * réel pour appeler POST /auth/google lui-même à travers le vrai @babana/api-client -- signIn()
 * ci-dessous fait le même sign-in par fetch brut, ce qui suffit aux fixtures de test/concurrency
 * mais n'exerce pas la validation de schéma que ce module-ci construit. */
export async function mintGoogleToken(sub: string, email: string): Promise<string> {
  const response = await fetch(`${MOCK_GOOGLE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub, email, aud: env('GOOGLE_OAUTH_CLIENT_IDS').split(',')[0]!.trim() }),
  });
  if (!response.ok) {
    throw new Error(`mock-google-identity /token : ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { id_token: string };
  return body.id_token;
}

export interface Session {
  accessToken: string;
  publicUserId: string;
}

/** Sign-in réel (POST /auth/google, contre le vrai mock-google-identity, D19) -- pas un jeton
 * fabriqué à la main : c'est le mécanisme entier (L1-01/L1-02) qui doit être vrai ici, puisque
 * c'est lui que les contrôleurs de L4-03 vérifient à chaque appel de ce test. */
export async function signIn(sub: string, role: 'client' | 'driver'): Promise<Session> {
  const idToken = await mintGoogleToken(sub, `${sub}@example.invalid`);
  const response = await fetch(`${ODOO_API_ROOT}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, role }),
  });
  if (!response.ok) {
    throw new Error(`POST /auth/google : ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { accessToken: string; user: { id: string } };
  return { accessToken: body.accessToken, publicUserId: body.user.id };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function callRideEndpoint<T = any>(
  path: string,
  session: Session,
  payload: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${ODOO_API_ROOT}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

/**
 * Appelle un endpoint du canal interne (D31, amoa/questions/REPONSES-2026-08-18.md §3) --
 * `/api/internal/rides/{id}/driver-accepted` en particulier, plus de route publique `/accept`.
 * Authentifié par le secret partagé (`X-Realtime-Secret`), jamais par un jeton d'utilisateur --
 * ces appels n'ont pas d'utilisateur humain derrière eux, même mécanisme que
 * services/odoo/addons/babana/controllers/internal.py côté Odoo.
 */
export async function callInternalEndpoint<T = any>(
  path: string,
  payload: Record<string, unknown> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${ODOO_HTTP_ROOT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Realtime-Secret': env('REALTIME_SHARED_SECRET'),
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

/**
 * Prépare un chauffeur approuvé, prêt à être proposé sur une course (documents vérifiés, moto
 * affectée, dossier approuvé) -- toutes des opérations à arguments simples (create/write/
 * action_approve), sûres en RPC (voir l'en-tête de ce fichier). `session` vient d'un vrai
 * sign-in (`signIn(sub, 'driver')`) : seul le token compte pour l'API mobile ensuite, mais
 * approuver le dossier exige de retrouver le babana.driver qui lui est rattaché.
 */
export async function approveDriver(session: Session, label: string): Promise<{ driverId: number; driverPublicId: string }> {
  const userIds = await execute<number[]>('res.users', 'search', [[['babana_public_id', '=', session.publicUserId]]]);
  const [userId] = userIds;
  const driverIds = await execute<number[]>('babana.driver', 'search', [[['user_id', '=', userId]]]);
  const driverId = driverIds[0]!;

  for (const documentType of ['license', 'id_card']) {
    const vals: Record<string, unknown> = {
      driver_id: driverId,
      document_type: documentType,
      storage_key: `test/concurrency/${label}-${documentType}.jpg`,
      verification_status: 'verified',
    };
    if (documentType === 'license') vals.expires_on = '2030-01-01';
    await execute('babana.driver.document', 'create', [vals]);
  }

  const plate = `LT-${Math.random().toString(36).slice(2, 6).toUpperCase()}-CC`;
  const [motorcycleId] = await execute<number[]>('babana.motorcycle', 'create', [[{ license_plate: plate }]]);
  await execute('babana.motorcycle', 'write', [[motorcycleId], { driver_id: driverId }]);

  await execute('babana.driver', 'action_approve', [[driverId]], { new_employee_name: `Chauffeur ${label}` });

  const [driverRecord] = await execute<{ public_id: string }[]>('babana.driver', 'read', [
    [driverId],
    ['public_id'],
  ]);
  const driverPublicId = driverRecord!.public_id;
  return { driverId, driverPublicId };
}

export async function createRideRequest(session: Session): Promise<{ ridePublicId: string }> {
  const userIds = await execute<number[]>('res.users', 'search', [[['babana_public_id', '=', session.publicUserId]]]);
  const [userId] = userIds;
  const [userRecord] = await execute<{ partner_id: [number, string] }[]>('res.users', 'read', [
    [userId],
    ['partner_id'],
  ]);
  const partnerId = userRecord!.partner_id[0];

  // action_request renvoie le recordset créé, sérialisé par le RPC générique d'Odoo en
  // repr() Python ("babana.ride(51,)"), pas en liste d'identifiants -- seules quelques
  // méthodes natives (create, search, ...) ont ce marshalling propre. On ignore donc la valeur
  // de retour et on retrouve la course par recherche, plutôt que de parser une repr fragile.
  await execute('babana.ride', 'action_request', [
    [],
    {
      client_id: partnerId,
      pickup_latitude: 4.05,
      pickup_longitude: 9.7,
      dropoff_latitude: 4.06,
      dropoff_longitude: 9.77,
      // Montant plausible (L4-11, scénario 3, encaissement) : une course créée directement par
      // action_request (pas par le vrai parcours quote -> createRide) n'a sinon aucun montant --
      // action_settle refuserait alors la création du mouvement de compte courant (L5-01, montant
      // non nul).
      estimated_amount: 1500,
    },
  ]);

  const rideIds = await execute<number[]>('babana.ride', 'search', [
    [
      ['client_id', '=', partnerId],
      ['state', '=', 'requested'],
    ],
    0,
    1,
    'id desc',
  ]);
  const rideId = rideIds[0]!;

  const [rideRecord] = await execute<{ public_id: string }[]>('babana.ride', 'read', [
    [rideId],
    ['public_id'],
  ]);
  const ridePublicId = rideRecord!.public_id;
  return { ridePublicId };
}

export async function readRideState(ridePublicId: string): Promise<string> {
  const rideIds = await execute<number[]>('babana.ride', 'search', [[['public_id', '=', ridePublicId]]]);
  const records = await execute<{ state: string }[]>('babana.ride', 'read', [rideIds, ['state']]);
  return records[0]!.state;
}
