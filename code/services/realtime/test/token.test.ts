import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyApplicationToken } from '../src/ws/token';

const SECRET = 'test-jwt-secret';

function sign(claims: Record<string, unknown>, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const validClaims = { sub: 'user-1', role: 'client' as const, exp: Math.floor(Date.now() / 1000) + 3600 };

describe('vérification du jeton applicatif (WS)', () => {
  test('accepte un jeton valide, signé avec le bon secret', () => {
    const claims = verifyApplicationToken(sign(validClaims), SECRET);
    assert.deepEqual(claims, validClaims);
  });

  test('rejette un jeton signé avec un autre secret', () => {
    const claims = verifyApplicationToken(sign(validClaims, 'wrong-secret'), SECRET);
    assert.equal(claims, null);
  });

  test('rejette un jeton expiré', () => {
    const expired = { ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 };
    const claims = verifyApplicationToken(sign(expired), SECRET);
    assert.equal(claims, null);
  });

  test('rejette un rôle invalide', () => {
    const claims = verifyApplicationToken(sign({ ...validClaims, role: 'admin' }), SECRET);
    assert.equal(claims, null);
  });

  test('rejette une chaîne malformée', () => {
    assert.equal(verifyApplicationToken('not-a-jwt', SECRET), null);
    assert.equal(verifyApplicationToken('', SECRET), null);
  });
});
