import { realtime } from '@babana/contracts';

type QuickMessageCode = realtime.QuickMessageCode;

/**
 * Libellés affichés des messages rapides (`chat.send` / `chat.message`) -- le fil ne porte qu'un
 * code, chaque app affiche ce texte. Partagé par les deux apps (même raison que les messages
 * d'erreur de `errors.ts`) : le chauffeur et le client lisent les mêmes mots.
 */
export const QUICK_MESSAGE_LABELS: Record<QuickMessageCode, string> = {
  driver_on_my_way: 'J’arrive',
  driver_outside: 'Je suis devant',
  driver_where_are_you: 'Où êtes-vous ?',
  driver_in_traffic: 'Je suis dans les embouteillages',
  client_coming: 'J’arrive',
  client_wait_please: 'Attendez-moi, s’il vous plaît',
  client_where_are_you: 'Où êtes-vous ?',
  client_at_pickup: 'Je suis au point de départ',
};

/** Les messages qu'un rôle peut envoyer, dans l'ordre d'affichage. */
export function quickMessagesFor(role: 'driver' | 'client'): QuickMessageCode[] {
  return realtime.QuickMessageCodeSchema.options.filter((code) => code.startsWith(`${role}_`));
}
