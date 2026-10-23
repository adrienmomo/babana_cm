import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HTTP_ENDPOINTS, IMPLICIT_ERRORS, IMPLICIT_AUTHENTICATED_ERRORS } from '../src/http/index';
import { ErrorCode, ERROR_HTTP_STATUS, ERROR_DESCRIPTION } from '../src/http/errors';
import { NearbyDriverSchema } from '../src/http/driver';

describe('critère 3 — chaque endpoint a un exemple de requête et de réponse valides contre son schéma', () => {
  for (const [name, endpoint] of Object.entries(HTTP_ENDPOINTS)) {
    test(`${name}: exemple de réponse valide`, () => {
      assert.doesNotThrow(() => endpoint.responseSchema.parse(endpoint.responseExample));
    });

    if (endpoint.requestSchema) {
      test(`${name}: exemple de requête valide`, () => {
        assert.doesNotThrow(() => endpoint.requestSchema!.parse(endpoint.requestExample));
      });
    } else {
      test(`${name}: pas de corps de requête (GET sans body)`, () => {
        assert.equal(endpoint.requestExample, null);
      });
    }
  }
});

describe('critère 4 — catalogue d\'erreurs exhaustif', () => {
  test('ERROR_HTTP_STATUS couvre tous les codes de ErrorCode', () => {
    assert.deepEqual(Object.keys(ERROR_HTTP_STATUS).sort(), [...ErrorCode.options].sort());
  });

  test('ERROR_DESCRIPTION couvre tous les codes de ErrorCode', () => {
    assert.deepEqual(Object.keys(ERROR_DESCRIPTION).sort(), [...ErrorCode.options].sort());
  });

  test('chaque code d\'erreur déclaré par un endpoint appartient au catalogue', () => {
    for (const [name, endpoint] of Object.entries(HTTP_ENDPOINTS)) {
      for (const code of endpoint.errors) {
        assert.ok(
          (ErrorCode.options as readonly string[]).includes(code),
          `${name} référence un code hors catalogue : ${code}`
        );
      }
    }
  });

  test('le catalogue minimal exigé par la spécification est présent', () => {
    const required = [
      'DRIVER_ALREADY_TAKEN',
      'CASH_LIMIT_REACHED',
      'RIDE_INVALID_TRANSITION',
      'NO_DRIVER_AVAILABLE',
      'QUOTE_EXPIRED',
      'PHONE_ALREADY_VERIFIED',
      'TOKEN_EXPIRED',
      'DRIVER_NOT_APPROVED',
    ];
    for (const code of required) {
      assert.ok((ErrorCode.options as readonly string[]).includes(code), `code requis manquant : ${code}`);
    }
  });

  test('IMPLICIT_ERRORS et IMPLICIT_AUTHENTICATED_ERRORS appartiennent au catalogue', () => {
    for (const code of [...IMPLICIT_ERRORS, ...IMPLICIT_AUTHENTICATED_ERRORS]) {
      assert.ok((ErrorCode.options as readonly string[]).includes(code));
    }
  });
});

describe('authentification — seuls les endpoints de connexion sont publics', () => {
  test('seuls Google (transitoire) et OTP ont requiresAuth = false', () => {
    const publicEndpoints = Object.entries(HTTP_ENDPOINTS).filter(([, e]) => !e.requiresAuth);
    assert.deepEqual(publicEndpoints.map(([name]) => name), ['authGoogle', 'authOtpRequest', 'authOtpVerify']);
  });
});

describe('C2b — nearby.drivers ne dépasse jamais le minimum de données personnelles', () => {
  test('un chauffeur proche n’est qu’une position arrondie et une distance', () => {
    assert.doesNotThrow(() => NearbyDriverSchema.parse({ position: { latitude: 4.05, longitude: 9.76 }, distanceMeters: 300 }));
  });

  test('rejette toute donnée du chauffeur (identifiant, prénom, photo, note, gamme)', () => {
    for (const extra of [
      { driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b' },
      { firstName: 'Paul' },
      { photoUrl: null },
      { rating: 4.8 },
      { motorcycleClass: 'standard' },
      { fullName: 'Paul Mbarga' },
    ]) {
      assert.throws(
        () => NearbyDriverSchema.parse({ position: { latitude: 4.05, longitude: 9.76 }, distanceMeters: 300, ...extra }),
        JSON.stringify(extra)
      );
    }
  });

  // Le plafond à 5 chauffeurs est couvert côté message WebSocket
  // (packages/contracts/test/realtime.test.ts, NearbyDriversMessageSchema) : `GET /drivers/nearby`
  // n'existe plus dans HTTP_ENDPOINTS, retiré du contrat sans avoir jamais été implémenté
  // (amoa/questions/C-01R.md §1).
});

describe('QUOTE_EXPIRED — une estimation expirée doit être refusée par /rides (critère métier de C-01)', () => {
  test('le schéma de réponse de /quote porte une date d\'expiration', () => {
    const endpoint = HTTP_ENDPOINTS.quote;
    const parsed = endpoint.responseSchema.parse(endpoint.responseExample);
    assert.ok('expiresAt' in parsed);
  });

  test('QUOTE_EXPIRED fait partie des erreurs possibles de POST /rides', () => {
    assert.ok(HTTP_ENDPOINTS.createRide.errors.includes('QUOTE_EXPIRED'));
  });
});

describe('indication de prise en charge (pickupNote) -- l’adresse formelle n’existe presque pas à Douala', () => {
  const schema = HTTP_ENDPOINTS.createRide.requestSchema;
  const quoteId = '7c9e2a1b-3d4e-4f5a-9b8c-1d2e3f4a5b6c';

  test('facultative : une commande sans indication reste valide', () => {
    assert.ok(schema.safeParse({ quoteId }).success);
  });

  test('un repère court est accepté, débarrassé de ses espaces', () => {
    const parsed = schema.parse({ quoteId, pickupNote: '  Devant la pharmacie du rond-point  ' });
    assert.equal(parsed.pickupNote, 'Devant la pharmacie du rond-point');
  });

  test('au-delà de 140 caractères, ou vide, refusé', () => {
    assert.equal(schema.safeParse({ quoteId, pickupNote: 'x'.repeat(141) }).success, false);
    assert.equal(schema.safeParse({ quoteId, pickupNote: '   ' }).success, false);
  });
});

describe('dispatchRide -- la course part au chauffeur disponible le plus proche, jamais choisi par le client', () => {
  const endpoint = HTTP_ENDPOINTS.dispatchRide;

  test('POST /rides/{id}/dispatch, authentifié, sans désignation de chauffeur dans le corps', () => {
    assert.equal(endpoint.method, 'POST');
    assert.equal(endpoint.path, '/api/v1/rides/{id}/dispatch');
    assert.equal(endpoint.requiresAuth, true);
    // Un corps qui tenterait de désigner un chauffeur est refusé : le choix appartient au serveur.
    assert.equal(endpoint.requestSchema.safeParse({ driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b' }).success, false);
    assert.ok(endpoint.requestSchema.safeParse({}).success);
  });

  test('« aucun chauffeur disponible » est une issue prévue, pas une panne', () => {
    assert.ok((endpoint.errors as readonly string[]).includes('NO_DRIVER_AVAILABLE'));
  });
});
