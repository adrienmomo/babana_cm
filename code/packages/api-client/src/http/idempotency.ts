import { randomUUID } from '../uuid';

/**
 * Une écriture porte un identifiant d'idempotence sur toutes ses tentatives réseau -- L4-03
 * (contrôleurs Odoo) rejoue la même réponse pour la même clé sans réappliquer la transition.
 *
 * Générée **une fois par appel externe** à `client.request(...)`, réutilisée pour les réessais
 * internes sur erreur réseau/serveur (`client.ts`) -- ce sont eux qui laissent un doute sur ce que
 * le serveur a réellement reçu. Un appel externe distinct (l'appelant retape après un
 * `NO_DRIVER_AVAILABLE`, ou `withTransparentRefresh` (L6-02) rejoue après un `TOKEN_EXPIRED`) en
 * génère une nouvelle : dans ces deux cas, le serveur a répondu de façon définitive avant
 * d'atteindre la transition -- TOKEN_EXPIRED échoue à l'authentification, avant tout appel de
 * méthode -- donc aucune transition n'a pu être appliquée, réutiliser la clé n'apporterait rien.
 */
export function generateIdempotencyKey(): string {
  return randomUUID();
}

/** POST est la seule méthode d'écriture du catalogue C-01 (voir @babana/contracts/http) -- une
 * lecture (GET) n'a pas besoin d'idempotence, elle est par nature rejouable. */
export function isWriteMethod(method: 'GET' | 'POST'): boolean {
  return method === 'POST';
}
