#!/usr/bin/env -S tsx
// Génère les schémas JSON consommés par les contrôleurs Odoo en Python (D17, critère
// d'acceptation 2 de C-01). Une paire de fichiers request/response par endpoint, plus le
// catalogue d'erreurs, dans dist/json-schema/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { HTTP_ENDPOINTS } from '../src/http';
import { ErrorCode, ERROR_HTTP_STATUS, ERROR_DESCRIPTION } from '../src/http/errors';

const outDir = join(__dirname, '..', 'dist', 'json-schema');
mkdirSync(outDir, { recursive: true });

// zod-to-json-schema@3.25.2 déclare son paramètre contre une version légèrement différente des
// types internes de zod@3.25.76 (ZodEffects notamment) ; le décalage n'affecte que la
// vérification de type, pas le comportement à l'exécution — d'où le cast ciblé plutôt qu'un
// alignement de version qui romprait potentiellement d'autres paquets du monorepo.
type AnyZodSchema = Parameters<typeof zodToJsonSchema>[0];

for (const [name, endpoint] of Object.entries(HTTP_ENDPOINTS)) {
  if (endpoint.requestSchema) {
    const schema = zodToJsonSchema(endpoint.requestSchema as unknown as AnyZodSchema, `${name}Request`);
    writeFileSync(join(outDir, `${name}.request.json`), JSON.stringify(schema, null, 2) + '\n');
  }
  const responseSchema = zodToJsonSchema(endpoint.responseSchema as unknown as AnyZodSchema, `${name}Response`);
  writeFileSync(join(outDir, `${name}.response.json`), JSON.stringify(responseSchema, null, 2) + '\n');
}

const errorCatalog = {
  codes: ErrorCode.options.map((code) => ({
    code,
    httpStatus: ERROR_HTTP_STATUS[code],
    description: ERROR_DESCRIPTION[code],
  })),
};
writeFileSync(join(outDir, 'errors.json'), JSON.stringify(errorCatalog, null, 2) + '\n');

console.log(`Schémas JSON générés dans ${outDir} (${Object.keys(HTTP_ENDPOINTS).length} endpoints).`);
