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
  /**
   * Identifiant public du chauffeur (babana.driver.public_id, distinct de
   * res.users.babana_public_id porté par `sub`) -- L3-01 en a besoin pour construire un
   * contexte de connexion immuable sans jamais appeler Odoo. L1-02 (hors de ce lot) n'a pas
   * encore émis de vrai jeton applicatif : comme pour le reste de cette interface (L0-04), une
   * hypothèse posée pour rester vérifiable ce soir, absente si le vrai jeton ne la porte pas
   * encore -- `ConnectionContext.driverId` (ws/auth.ts) vaut alors `null` plutôt qu'une
   * supposition risquée (jamais confondu avec `sub`).
   */
  driverId?: string;
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export type TokenVerificationFailureReason = 'invalid' | 'expired';

export type TokenVerificationResult =
  | { ok: true; claims: ApplicationTokenClaims }
  | { ok: false; reason: TokenVerificationFailureReason };

/**
 * Vérifie la signature, la forme des claims, puis l'expiration -- dans cet ordre, pour ne
 * jamais distinguer "expiré" d'"invalide" à partir d'un jeton dont la signature n'a pas encore
 * été prouvée authentique (un jeton falsifié ne doit rien révéler sur sa propre validité avant
 * la vérification de signature). Partagée par `verifyApplicationToken` (inchangée, L0-04) et
 * `verifyApplicationTokenWithReason` (nouvelle, L3-01 -- ws/auth.ts en a besoin pour distinguer
 * les deux cas avec des codes de fermeture WebSocket différents, critère d'acceptation 2).
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

  let claims: ApplicationTokenClaims;
  try {
    claims = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (typeof claims.exp !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof claims.sub !== 'string' || (claims.role !== 'client' && claims.role !== 'driver')) {
    return { ok: false, reason: 'invalid' };
  }
  if (claims.driverId !== undefined && typeof claims.driverId !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
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
