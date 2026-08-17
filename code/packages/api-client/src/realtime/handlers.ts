import { realtime } from '@babana/contracts';
import { reportMetric } from '../metrics';

/**
 * État de connexion exposé aux écrans (L6-04, spécification -- "pour que l'interface puisse le
 * montrer sans ambiguïté", L6-16). Trois états, jamais deux : un chauffeur qui se croit
 * disponible alors que sa connexion vient de tomber doit pouvoir le distinguer d'une connexion
 * réellement établie -- `L6-11` (bascule en ligne/hors ligne) en a explicitement besoin.
 */
export type ConnectionState = 'offline' | 'connecting' | 'connected';

/**
 * Un message entrant non conforme au schéma est ignoré et signalé en métrique, il ne fait pas
 * tomber l'app (critère 5) -- ni un JSON malformé, ni une forme qui ne correspond à aucun message
 * connu du contrat C-02 (une app plus ancienne qu'un serveur qui aurait gagné un type de message).
 */
export function parseIncomingMessage(raw: string): realtime.ServerToClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    reportMetric('realtime.invalid_message', { reason: 'json_parse' });
    return null;
  }

  const parsed = realtime.ServerToClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    reportMetric('realtime.invalid_message', { reason: 'schema', issues: parsed.error.issues.length });
    return null;
  }
  return parsed.data;
}
