import type { Config } from '../config';

/**
 * Limitation de débit par jeton (L8-03, critère d'acceptation 6) -- même patron que
 * `nearby/handler.ts::allowSubscribe` (fenêtre glissante en mémoire), pas un second mécanisme à
 * inventer. Par jeton plutôt que par IP : un proche et le client lui-même peuvent légitimement
 * partager la même IP (réseau mobile avec NAT partagé, cas courant à Douala), la limite doit
 * suivre le lien partagé, pas l'origine réseau.
 */
export class ShareRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: Config) {}

  allow(token: string, nowMs: number = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const windowMs = this.config.SHARE_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const cutoff = nowMs - windowMs;
    const recent = (this.hits.get(token) ?? []).filter((hitMs) => hitMs > cutoff);
    if (recent.length >= this.config.SHARE_RATE_LIMIT_MAX_REQUESTS) {
      this.hits.set(token, recent);
      const oldest = Math.min(...recent);
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (nowMs - oldest)) };
    }
    recent.push(nowMs);
    this.hits.set(token, recent);
    return { allowed: true };
  }
}
