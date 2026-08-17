/**
 * Codes de fermeture WebSocket applicatifs (C-02) -- plage 4000-4999 réservée par la RFC 6455
 * §7.4.2 à l'usage applicatif. Un jeton manquant ou invalide (ré-authentification complète
 * nécessaire) et un jeton expiré (renouvellement via /auth/refresh puis reconnexion, sans
 * ré-authentifier l'utilisateur) ferment la connexion avec deux codes distincts (L3-01, critère
 * d'acceptation 2) : `services/realtime` les émet, `packages/api-client` (L6-04) doit les
 * distinguer pour savoir renouveler ou ré-authentifier.
 *
 * Déplacés ici depuis `services/realtime/src/ws/auth.ts` (L3-01, où ils étaient nés faute
 * d'un consommateur côté client) au moment où L6-04 en a eu besoin -- une seule définition
 * (D17), jamais une paire de valeurs recopiées de chaque côté. C'est exactement la classe de
 * défaut que D23 a révélée le 15 août (deux services d'accord sur rien, `01-architecture.md`
 * §5) : un format qui voyage dans un en-tête ou une fermeture de connexion est un contrat au
 * même titre qu'une requête ou un message.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_TOKEN_EXPIRED = 4402;
