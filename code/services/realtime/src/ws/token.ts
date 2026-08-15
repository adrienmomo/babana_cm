import crypto from 'node:crypto';
import { auth } from '@babana/contracts';

/**
 * Vérification du jeton applicatif (HS256, secret partagé JWT_SECRET -- même secret qu'Odoo
 * pour émettre le jeton, voir infra/compose.yaml). La forme des claims n'est plus déclarée ici :
 * elle vient de `AccessTokenClaimsSchema` (@babana/contracts, D23) -- le même schéma que celui
 * qu'Odoo respecte à l'émission (controllers/auth.py:_issue_access_token). Avant D23, ce module
 * redéclarait sa propre forme (sub, role, exp) à côté de celle qu'Odoo émettait réellement
 * (uid, role, iat, exp, jti) : les deux suites étaient vertes en désaccord total, et aucun
 * jeton réel n'était jamais accepté (amoa/questions/REPONSES-2026-08-15.md, §1).
 */
export type ApplicationTokenClaims = auth.AccessTokenClaims;

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export type TokenVerificationFailureReason = 'invalid' | 'expired';

export type TokenVerificationResult =
  | { ok: true; claims: ApplicationTokenClaims }
  | { ok: false; reason: TokenVerificationFailureReason };

/**
 * Vérifie la signature, la forme des claims (contre `AccessTokenClaimsSchema`), puis
 * l'expiration -- dans cet ordre, pour ne jamais distinguer "expiré" d'"invalide" à partir d'un
 * jeton dont la signature n'a pas encore été prouvée authentique (un jeton falsifié ne doit rien
 * révéler sur sa propre validité avant la vérification de signature). Partagée par
 * `verifyApplicationToken` et `verifyApplicationTokenWithReason` (ws/auth.ts en a besoin pour
 * distinguer les deux cas avec des codes de fermeture WebSocket différents, critère
 * d'acceptation 2 de L3-01).
 */
function verify(token: string, secret: string): TokenVerificationResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actualSignature = base64urlDecode(signatureB64);

  if (
    expectedSignature.length !== actualSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return { ok: false, reason: 'invalid' };
  }

  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const parsed = auth.AccessTokenClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }
  const claims = parsed.data;

  if (claims.exp * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims };
}

export function verifyApplicationToken(token: string, secret: string): ApplicationTokenClaims | null {
  const result = verify(token, secret);
  return result.ok ? result.claims : null;
}

export function verifyApplicationTokenWithReason(token: string, secret: string): TokenVerificationResult {
  return verify(token, secret);
}
