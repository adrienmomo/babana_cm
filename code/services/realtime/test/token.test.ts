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

// Claims conformes à AccessTokenClaimsSchema (@babana/contracts, D23) -- sub/jti en UUID,
// iat/exp en secondes epoch : la même forme qu'Odoo émet réellement (controllers/auth.py).
const validClaims = {
  sub: crypto.randomUUID(),
  role: 'client' as const,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: crypto.randomUUID(),
};

const validDriverClaims = {
  sub: crypto.randomUUID(),
  role: 'driver' as const,
  driverId: crypto.randomUUID(),
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: crypto.randomUUID(),
};

describe('vérification du jeton applicatif (WS)', () => {
  test('accepte un jeton valide, signé avec le bon secret', () => {
    const claims = verifyApplicationToken(sign(validClaims), SECRET);
    assert.deepEqual(claims, validClaims);
  });

  test('accepte un jeton chauffeur valide, driverId distinct de sub', () => {
    const claims = verifyApplicationToken(sign(validDriverClaims), SECRET);
    assert.deepEqual(claims, validDriverClaims);
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

  // --- D23 : la forme est désormais un contrat partagé (AccessTokenClaimsSchema), pas une
  // déclaration locale -- ces deux cas sont ceux qu'une redéclaration locale aurait pu laisser
  // passer (amoa/questions/REPONSES-2026-08-15.md §1).

  test('rejette un jeton chauffeur sans driverId -- obligatoire sur un jeton chauffeur (D23)', () => {
    const { driverId: _omitted, ...withoutDriverId } = validDriverClaims;
    const claims = verifyApplicationToken(sign(withoutDriverId), SECRET);
    assert.equal(claims, null);
  });

  test("rejette la forme historique du jeton (\"uid\" au lieu de \"sub\") -- c'est le défaut réparé", () => {
    const { sub, ...rest } = validClaims;
    const legacyShape = { uid: sub, ...rest };
    const claims = verifyApplicationToken(sign(legacyShape), SECRET);
    assert.equal(claims, null);
  });
});
