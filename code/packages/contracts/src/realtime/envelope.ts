import { z } from 'zod';
import { IsoDateTimeSchema } from '../http/common';

/**
 * Enveloppe commune à tout message WebSocket, dans les deux sens. `id` sert à l'idempotence
 * côté réception : un message rejoué après reconnexion (même `id`) ne doit pas produire deux
 * effets. `emittedAt` permet au serveur d'ignorer une position trop ancienne plutôt que de la
 * rejouer (politique de reconnexion, voir docs/contracts/realtime-events.md).
 */
export const MessageIdSchema = z.string().uuid();

export function envelopeSchema<Type extends string, Payload extends z.ZodTypeAny>(
  type: Type,
  payload: Payload
) {
  return z.object({
    type: z.literal(type),
    id: MessageIdSchema,
    emittedAt: IsoDateTimeSchema,
    payload,
  });
}

export type EnvelopeOf<Type extends string, Payload> = {
  type: Type;
  id: string;
  emittedAt: string;
  payload: Payload;
};
