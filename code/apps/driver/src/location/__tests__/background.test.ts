import { formatLastSentMessage } from '../background';

/**
 * `formatLastSentMessage` porte à lui seul la règle du 3 septembre (L6-05, spécification ;
 * `amoa/questions/REPONSES-2026-09-03.md` §2) : la notification persistante CONSTATE quand la
 * dernière position est réellement partie, elle n'affirme jamais un « suivi actif » que rien ne
 * garantit sans service de premier plan natif.
 */
describe('formatLastSentMessage (L6-05, la notification qui constate)', () => {
  const T0 = 1_000_000;

  test('aucun envoi depuis le passage en ligne : le dit, sans rien prétendre d’autre', () => {
    expect(formatLastSentMessage(null, T0)).toMatch(/pas encore envoyée/i);
  });

  test('envoi à l’instant', () => {
    expect(formatLastSentMessage(T0, T0)).toBe('Dernière position envoyée à l’instant.');
    expect(formatLastSentMessage(T0, T0 + 59_000)).toBe('Dernière position envoyée à l’instant.');
  });

  test('il y a N minutes -- singulier puis pluriel', () => {
    expect(formatLastSentMessage(T0, T0 + 60_000)).toBe('Dernière position envoyée il y a 1 minute.');
    expect(formatLastSentMessage(T0, T0 + 179_000)).toBe('Dernière position envoyée il y a 2 minutes.');
    expect(formatLastSentMessage(T0, T0 + 42 * 60_000)).toBe('Dernière position envoyée il y a 42 minutes.');
  });

  test('une horloge qui recule ne produit pas un nombre négatif', () => {
    expect(formatLastSentMessage(T0, T0 - 5_000)).toBe('Dernière position envoyée à l’instant.');
  });
});
