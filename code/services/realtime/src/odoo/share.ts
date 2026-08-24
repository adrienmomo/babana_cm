import type { Config } from '../config';
import { callOdoo } from './client';

/**
 * Sens temps réel -> Odoo (L8-03) : Odoo possède le jeton et sa validité (D27), ce service ne
 * calcule jamais lui-même une expiration -- il la redemande ici à chaque page publique servie.
 * Bloquant pour son appelant (`share/handler.ts`), même raisonnement que `fetchDriverProfiles`
 * (odoo/driver-profiles.ts) : la réponse HTTP publique a besoin du résultat avant de pouvoir
 * répondre quoi que ce soit.
 *
 * Liste blanche déjà appliquée côté Odoo (`controllers/internal.py::_resolve_share`) -- ce
 * fichier ne fait que transporter la réponse, jamais un second endroit qui déciderait quels
 * champs exposer.
 */
export interface ResolvedShare {
  active: boolean;
  rideId?: string;
  phase?: 'approach' | 'course';
  destination?: { latitude: number; longitude: number };
  driverFirstName?: string | null;
  motorcycleClass?: 'standard' | 'premium' | null;
  expiresAt?: string | null;
}

export async function resolveShare(config: Config, token: string): Promise<ResolvedShare> {
  const result = await callOdoo(config, '/api/internal/share/resolve', { token }, { retries: 1, baseDelayMs: 100 });
  const body = result as ResolvedShare;
  if (!body || typeof body.active !== 'boolean') return { active: false };
  return body;
}
