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

for (const [name, endpoint] of Object.entries(HTTP_ENDPOINTS)) {
  if (endpoint.requestSchema) {
    const schema = zodToJsonSchema(endpoint.requestSchema, `${name}Request`);
    writeFileSync(join(outDir, `${name}.request.json`), JSON.stringify(schema, null, 2) + '\n');
  }
  const responseSchema = zodToJsonSchema(endpoint.responseSchema, `${name}Response`);
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
