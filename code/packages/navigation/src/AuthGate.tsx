import type { ReactElement } from 'react';
import type { SessionState } from './session';

export interface AuthGateProps<TUser> {
  session: SessionState<TUser>;
  renderLoading: () => ReactElement;
  renderSignedOut: () => ReactElement;
  renderSignedIn: (user: TUser) => ReactElement;
}

/**
 * Garde d'authentification (L6-00, critères d'acceptation 3 et 4). Montée une seule fois, à la
 * racine de chaque application -- jamais répétée dans un écran, sans quoi le quinzième l'oublie
 * (CLAUDE.md, contexte de la tâche).
 *
 * La garantie tient à la structure, pas à une vérification : le sous-arbre rendu par
 * `renderSignedIn` (les navigateurs métier, avec tous leurs écrans) n'est **monté** que quand
 * `session.status === 'authenticated'`. Un utilisateur sans session valide ne peut pas naviguer
 * vers un écran métier en le demandant directement (critère 3) -- ces écrans n'existent
 * simplement pas dans l'arbre React tant que la session n'est pas là, ce qu'aucune vérification
 * au niveau de chaque écran ne peut garantir aussi fort.
 *
 * Même mécanisme pour la perte de session en cours d'usage (critère 4) : quand `onSessionLost`
 * (L6-02) fait passer `session.status` à `unauthenticated`, React démonte tout le sous-arbre
 * authentifié et monte `renderSignedOut()` à sa place -- depuis n'importe quel écran, puisque
 * c'est la racine commune à tous qui vient de changer.
 */
export function AuthGate<TUser>({
  session,
  renderLoading,
  renderSignedOut,
  renderSignedIn,
}: AuthGateProps<TUser>): ReactElement {
  switch (session.status) {
    case 'loading':
      return renderLoading();
    case 'unauthenticated':
      return renderSignedOut();
    case 'authenticated':
      return renderSignedIn(session.user);
    default: {
      const _exhaustive: never = session;
      throw new Error(`@babana/navigation: état de session inconnu: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
