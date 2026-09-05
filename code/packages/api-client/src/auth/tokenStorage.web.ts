import type { StoredSession, TokenStorage } from './tokenStorage';

/**
 * Équivalent web de `tokenStorage.ts` (L6-18, D39, 24 août) -- résolu à la place du natif par
 * l'extension `.web.ts` (même mécanisme que `location.web.ts`/`config.web.ts`, étendu ici à un
 * paquet prébuilt : `tsconfig.web.json` compile ce fichier séparément vers `dist/auth/
 * tokenStorage.web.js`, et c'est `resolve.extensions` de `apps/client/webpack.config.js` qui le
 * préfère au moment du bundle web -- jamais un `Platform.OS` lu à l'exécution).
 *
 * Un navigateur n'a pas de trousseau système à qui déléguer (contrairement à iOS/Android) : tout
 * ce qu'on range dans son stockage persistant (`localStorage`, IndexedDB) est lisible par
 * n'importe quelle injection de script, et un jeton de renouvellement y serait une session
 * entière offerte, survivant à l'expiration du jeton d'accès. D39 tranche donc : **rien n'est
 * persisté**, la session vit en mémoire seulement, le temps de vie de l'onglet. Fermer l'onglet
 * (ou recharger la page) efface `session` ci-dessous au même titre qu'un redémarrage d'app
 * effacerait une variable de processus -- c'est la dégradation, et elle se signale à
 * l'utilisateur (`apps/client/src/components/WebDemoBanner.tsx`), elle ne se masque pas.
 *
 * Le contournement du 24 août (`webpack-stubs/react-native-keychain.web.js`, qui écrivait en
 * clair dans `localStorage`) disparaît avec cette tâche : son alias est retiré de
 * `webpack.config.js`, et plus aucun fichier de ce paquet n'importe `react-native-keychain` dans
 * le graphe du bundle web.
 */
let session: StoredSession | null = null;

export const secureTokenStorage: TokenStorage = {
  async save(next) {
    session = next;
  },

  async load() {
    return session;
  },

  async clear() {
    session = null;
  },
};
