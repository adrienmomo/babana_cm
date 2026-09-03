// D64 -- L1-05, critères 6 et 7 (amoa/01-architecture.md §9 octies, amoa/specs/L1-identite.md).
//
// C'est ce fichier qui prouve ce que `test_documents.py` ne peut structurellement pas prouver :
// il tourne sur le PROCESSUS DE TEST -- le host, jamais un conteneur (`npm test` s'exécute sur
// la machine qui lance `make test`, comme tout le reste de `test/`). Le défaut du 16 septembre
// (`amoa/questions/L1-05-signed-url-unreachable.md`) était exactement ça : une URL signée
// vérifiée depuis l'intérieur du conteneur Odoo, où le nom de service Docker se résout -- vraie
// à cet endroit précis, fausse partout où un vrai navigateur se tient. Critère 6 exige un
// client qui « ne résout aucun nom de service » : ce processus en est un.
//
// Critère 7 (console inatteignable par une route publique) est vérifié contre la VRAIE route
// Caddy (`storage.<domaine>`, infra/caddy/Caddyfile), TLS auto-signé accepté explicitement
// (`rejectUnauthorized: false`, node:https natif) -- même geste que `infra/smoke-test.sh`
// (`curl -ks`), transposé ici pour une assertion automatisée.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

import { signIn, ODOO_API_ROOT } from '../concurrency/helpers/odoo-session';

const STORAGE_PUBLIC_ROOT = process.env.STORAGE_PUBLIC_ROOT ?? 'https://storage.localhost';

const A_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.alloc(32)]);

async function uploadIdCard(accessToken: string): Promise<number> {
  const form = new FormData();
  form.set('documentType', 'id_card');
  form.set('contentType', 'image/jpeg');
  form.set('file', new Blob([A_JPEG], { type: 'image/jpeg' }), 'piece.jpg');
  const response = await fetch(`${ODOO_API_ROOT}/driver/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const body = (await response.json()) as { id: number };
  assert.equal(response.status, 201, `upload en préparation a échoué : ${JSON.stringify(body)}`);
  return body.id;
}

/** GET via HTTPS, certificat auto-signé accepté (Caddy en développement) -- `node:https` natif,
 * jamais une dépendance nouvelle : `fetch` global ne permet pas de désactiver la vérification du
 * certificat sans passer par un `Agent` non standard. */
function getInsecure(url: string): Promise<{ status: number; body: Buffer; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          contentType: res.headers['content-type'],
        })
      );
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('D64 -- le point d\'entrée public du stockage (L1-05, critères 6 et 7)', () => {
  test(
    "critère 6 : l'URL signée est joignable depuis l'extérieur du réseau interne, sans résoudre aucun nom de service",
    { timeout: 30_000 },
    async () => {
      const session = await signIn(`sub-d64-reachable-${randomUUID()}`, 'driver');
      const documentId = await uploadIdCard(session.accessToken);

      const urlResponse = await fetch(`${ODOO_API_ROOT}/driver/documents/${documentId}/url`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const urlBody = (await urlResponse.json()) as { url: string };
      assert.equal(urlResponse.status, 200, `GET .../url a échoué : ${JSON.stringify(urlBody)}`);
      const { url } = urlBody;

      // La preuve la plus directe du défaut du 16 septembre : le nom de service Docker interne
      // ne doit plus jamais apparaître dans une URL renvoyée à un appelant externe.
      const signedHost = new URL(url).hostname;
      assert.notEqual(
        signedHost,
        'minio',
        `l'URL signée ne doit jamais porter le nom de service Docker interne, obtenu : ${url}`
      );

      // Le fetch lui-même EST la preuve du critère 6 : ce processus est le host qui lance
      // `npm test`, jamais un conteneur -- il ne résout "minio" nulle part, pour la même raison
      // qu'un navigateur ne le pourrait pas.
      const objectResponse = await fetch(url);
      assert.equal(objectResponse.status, 200, "l'URL signée doit être atteignable depuis l'extérieur");
      const bytes = Buffer.from(await objectResponse.arrayBuffer());
      assert.ok(bytes.equals(A_JPEG), "le contenu récupéré via l'URL signée doit correspondre au fichier téléversé");
    }
  );

  test(
    'critère 7 : la console d\'administration du stockage n\'est atteignable par aucune route publique',
    { timeout: 15_000 },
    async () => {
      // La route publique dédiée (infra/caddy/Caddyfile, storage.<domaine>) ne proxifie QUE le
      // port S3 de MinIO (9000) -- jamais 9001 (console). Vérifié en interrogeant cette route
      // (jamais le port 9001 directement, qui n'est publié qu'en développement pour le confort
      // de l'équipe, infra/compose.dev.yaml -- une commodité locale, pas la route de production)
      // et en confirmant que la réponse est celle de l'API S3 (une erreur XML), jamais celle de
      // la console (une page HTML « MinIO Console »).
      const response = await getInsecure(`${STORAGE_PUBLIC_ROOT}/`);

      assert.notEqual(
        response.contentType?.split(';')[0]?.trim(),
        'text/html',
        `la route publique du stockage ne doit jamais servir de HTML (signature de la console) -- reçu Content-Type: ${response.contentType}`
      );
      assert.ok(
        !response.body.toString('utf8').includes('MinIO Console'),
        'la console MinIO ne doit être atteignable par aucune route publique'
      );
      // Réponse attendue de l'API S3 elle-même sur un GET racine non signé : une erreur
      // (AccessDenied, sans identifiants) -- au même titre que le critère 1 de L1-05, « vérifié
      // par un appel qui échoue ».
      assert.equal(response.status, 403, `réponse attendue de l'API S3 (403 AccessDenied), reçu ${response.status}`);
    }
  );
});
