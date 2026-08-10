import crypto from 'node:crypto';

/**
 * Vérification du jeton applicatif (HS256, secret partagé JWT_SECRET -- même secret
 * qu'Odoo pour émettre le jeton, voir infra/compose.yaml). L1-01, hors du lot de cette nuit,
 * n'a pas encore émis de vrai jeton applicatif : la forme exacte des claims ci-dessous
 * (sub, role, exp) est une hypothèse posée pour que ce squelette soit vérifiable ce soir --
 * à confirmer ou ajuster quand L1-01 émettra réellement ces jetons.
 */
export interface ApplicationTokenClaims {
  sub: string;
  role: 'client' | 'driver';
  exp: number;
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function verifyApplicationToken(token: string, secret: string): ApplicationTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
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
    return null;
  }

  let claims: ApplicationTokenClaims;
  try {
    claims = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    return null;
  }
  if (typeof claims.sub !== 'string' || (claims.role !== 'client' && claims.role !== 'driver')) {
    return null;
  }

  return claims;
}
