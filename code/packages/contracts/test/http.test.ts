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

describe('authentification — seul /auth/google est public (spécification, littéralement)', () => {
  test('un seul endpoint a requiresAuth = false', () => {
    const publicEndpoints = Object.entries(HTTP_ENDPOINTS).filter(([, e]) => !e.requiresAuth);
    assert.deepEqual(publicEndpoints.map(([name]) => name), ['authGoogle']);
  });
});

describe('C2b — nearby.drivers ne dépasse jamais le minimum de données personnelles', () => {
  test('rejette un champ en trop (nom complet par exemple)', () => {
    const withExtra = {
      driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
      firstName: 'Paul',
      photoUrl: null,
      rating: 4.8,
      motorcycleClass: 'standard',
      position: { latitude: 4.05, longitude: 9.76 },
      distanceMeters: 300,
      fullName: 'Paul Mbarga',
    };
    assert.throws(() => NearbyDriverSchema.parse(withExtra));
  });

  test('la réponse nearby limite à 5 chauffeurs', () => {
    const endpoint = HTTP_ENDPOINTS.nearbyDrivers;
    const tooMany = {
      drivers: Array.from({ length: 6 }, (_, i) => ({
        driverId: `00000000-0000-4000-8000-00000000000${i}`,
        firstName: 'X',
        photoUrl: null,
        rating: 5,
        motorcycleClass: 'standard',
        position: { latitude: 4.05, longitude: 9.76 },
        distanceMeters: 100,
      })),
    };
    assert.throws(() => endpoint.responseSchema.parse(tooMany));
  });
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
