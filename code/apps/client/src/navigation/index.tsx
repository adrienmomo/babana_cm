import React, { useEffect, useState } from 'react';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthGate, PlaceholderScreen, type SessionState } from '@babana/navigation';
import { ApiError, type AuthState, type AuthUser } from '@babana/api-client';
import { apiClient, authClient, onSessionLost } from '../auth';
import { bootstrap } from '../bootstrap';
import { SignInScreen } from '../screens/SignInScreen';
import type { AuthParamList, ClientParamList } from './types';

const AuthStack = createNativeStackNavigator<AuthParamList>();
const ClientStack = createNativeStackNavigator<ClientParamList>();

/**
 * Réf partagée -- `./transitions.ts` (L6-08 et suivants) l'utilise pour `reset()` sans avoir à
 * faire remonter un ref depuis un écran profondément imbriqué. Typée `ClientParamList` seulement
 * (jamais `AuthParamList`) : la garde d'authentification garantit qu'aucun de ces noms de route
 * n'est monté avant que la session ne soit authentifiée, donc jamais atteignable plus tôt.
 */
export const navigationRef = createNavigationContainerRef<ClientParamList>();

/**
 * Racine de navigation de l'app Client (L6-00). `bootstrap()` (Google Sign-In, fournisseur de
 * carte) et la relecture de la session sont faits une fois ici, avant que quoi que ce soit ne se
 * monte -- ni les écrans métier ni même l'écran de connexion n'ont à s'en soucier.
 *
 * **`GET /me` après `restore()`, plus de renouvellement proactif (D35).** `AuthClient.restore()`
 * (L6-02) relit les jetons du trousseau mais n'y a jamais persisté `user` -- après un
 * redémarrage, `state.user` est vide, sans `driverStatus`. Avant D35, aucun endpoint ne renvoyait
 * le profil : ce fichier appelait `authClient.refresh()` au démarrage, uniquement pour ce
 * profil -- un renouvellement de jeton déclenché sans qu'aucun jeton n'ait expiré, qui
 * multipliait par le nombre de démarrages les occasions de perdre une famille de jetons
 * (rotation, L1-02). `GET /me` porte le même objet utilisateur sans toucher aux jetons ;
 * `authClient.refreshUser(apiClient)` l'appelle via le client enrobé de renouvellement
 * transparent, pour que ce renouvellement redevienne ce qu'il doit être : une réaction à une
 * expiration (`TOKEN_EXPIRED`), pas un appel systématique. Hors ligne (l'exception n'est pas une
 * `ApiError`, `fetch` a levé avant d'atteindre le serveur), on continue avec la session restaurée
 * plutôt que de bloquer le démarrage -- le réseau intermittent est le cas courant (CLAUDE.md), et
 * le serveur reste de toute façon l'arbitre final de ce que l'utilisateur peut faire
 * (invariant 3).
 */
function useSession() {
  const [session, setSession] = useState<SessionState<AuthUser>>({ status: 'loading' });

  useEffect(() => {
    bootstrap();
    let cancelled = false;

    (async () => {
      const restored = await authClient.restore();
      if (cancelled) return;
      if (!restored) {
        setSession({ status: 'unauthenticated' });
        return;
      }
      try {
        const fresh = await authClient.refreshUser(apiClient);
        if (!cancelled) setSession({ status: 'authenticated', user: fresh.user });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError) {
          // Jeton de renouvellement révoqué/expiré -- le renouvellement transparent (apiClient)
          // a déjà déclenché handleRefreshFailure() (session.ts), qui efface le trousseau et
          // appelle onSessionLost(). L'abonnement ci-dessous fera passer session à
          // 'unauthenticated'.
          return;
        }
        // Hors ligne : on continue avec l'état restauré plutôt que de bloquer le démarrage.
        setSession({ status: 'authenticated', user: restored.user });
      }
    })();

    const unsubscribe = onSessionLost(() => {
      if (!cancelled) setSession({ status: 'unauthenticated' });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  function handleSignedIn(authState: AuthState) {
    setSession({ status: 'authenticated', user: authState.user });
  }

  return { session, handleSignedIn };
}

function LoadingScreen() {
  return <PlaceholderScreen title="Babana" task="chargement de la session" />;
}

function SignInStack({ onSignedIn }: { onSignedIn: (session: AuthState) => void }) {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="SignIn">
        {/* La navigation authentifiée se monte via AuthGate dès que `session` change --
            rien à faire ici pour "naviguer vers Home", le sous-arbre entier est remplacé. */}
        {() => <SignInScreen onSignedIn={onSignedIn} />}
      </AuthStack.Screen>
    </AuthStack.Navigator>
  );
}

function ClientNavigator() {
  return (
    <ClientStack.Navigator initialRouteName="Home">
      <ClientStack.Screen name="Home">
        {() => <PlaceholderScreen title="Accueil" task="L6-06" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="Quote">
        {() => <PlaceholderScreen title="Estimation" task="L6-07" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="Waiting">
        {() => <PlaceholderScreen title="Attente" task="L6-08" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="DriverRejected">
        {() => <PlaceholderScreen title="Chauffeur indisponible" task="L6-08" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="Tracking">
        {() => <PlaceholderScreen title="Suivi de course" task="L6-09" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="RideSummary">
        {() => <PlaceholderScreen title="Résumé" task="L6-09" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="History">
        {() => <PlaceholderScreen title="Historique" task="L6-10" />}
      </ClientStack.Screen>
      <ClientStack.Screen name="Invoice">
        {() => <PlaceholderScreen title="Facture" task="L6-10" />}
      </ClientStack.Screen>
    </ClientStack.Navigator>
  );
}

export function AppNavigator() {
  const { session, handleSignedIn } = useSession();

  return (
    <NavigationContainer ref={navigationRef}>
      <AuthGate<AuthUser>
        session={session}
        renderLoading={() => <LoadingScreen />}
        renderSignedOut={() => <SignInStack onSignedIn={handleSignedIn} />}
        renderSignedIn={() => <ClientNavigator />}
      />
    </NavigationContainer>
  );
}
