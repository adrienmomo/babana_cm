/**
 * État de session consommé par `AuthGate` (L6-00). Générique sur `TUser` plutôt que dépendant de
 * `@babana/api-client` : ce paquet ne connaît que la forme de l'état, jamais le client
 * d'authentification lui-même -- chaque app câble son propre `AuthClient` (L6-02) vers cette
 * forme dans `src/navigation/index.tsx`.
 *
 * `loading` existe séparément de `unauthenticated` : au démarrage, le temps de relire le
 * trousseau sécurisé (`AuthClient.restore()`), l'app ne sait pas encore si une session existe.
 * La confondre avec `unauthenticated` ferait clignoter l'écran de connexion à chaque lancement.
 */
export type SessionState<TUser> =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: TUser };
