import React, { useEffect, useState } from 'react';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthGate, PlaceholderScreen, type SessionState } from '@babana/navigation';
import { ApiError, type AuthState, type AuthUser } from '@babana/api-client';
import { authClient, onSessionLost } from '../auth';
import { bootstrap } from '../bootstrap';
import { SignInScreen } from '../screens/SignInScreen';
import type { AuthParamList, DriverParamList, DriverPendingParamList } from './types';

const AuthStack = createNativeStackNavigator<AuthParamList>();
const DriverStack = createNativeStackNavigator<DriverParamList>();
const PendingStack = createNativeStackNavigator<DriverPendingParamList>();

/**
 * Réf partagée -- `./transitions.ts` (L6-12, L6-14) l'utilise pour `reset()`. Typée
 * `DriverParamList` seulement : valide uniquement quand `DriverNavigator` est monté (chauffeur
 * `approved`), exactement le cas où ces transitions ont un sens.
 */
export const navigationRef = createNavigationContainerRef<DriverParamList>();

/**
 * Racine de navigation de l'app Chauffeur (L6-00) -- même bootstrap de session que
 * apps/client/src/navigation/index.tsx (voir ce fichier pour le détail du raisonnement sur le
 * `refresh()` proactif). Ici, ce rafraîchissement compte particulièrement : c'est lui qui donne
 * un `driverStatus` à jour dès l'ouverture de l'app, avant même le premier écran.
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
        const fresh = await authClient.refresh();
        if (!cancelled) setSession({ status: 'authenticated', user: fresh.user });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError) {
          // handleRefreshFailure() (session.ts) a déjà effacé le trousseau et appelé
          // onSessionLost() -- l'abonnement ci-dessous fera passer session à 'unauthenticated'.
          return;
        }
        // Hors ligne : on continue avec le statut restauré (potentiellement périmé) plutôt que
        // de bloquer le démarrage -- voir le garde-fou de renderSignedIn ci-dessous : par
        // défaut-refus, un statut inconnu ou périmé route vers Pending, jamais vers les écrans
        // de course (le serveur reste l'arbitre final, invariant 3 -- DRIVER_NOT_APPROVED existe
        // précisément pour ce cas).
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
  return <PlaceholderScreen title="Babana Chauffeur" task="chargement de la session" />;
}

function SignInStack({ onSignedIn }: { onSignedIn: (session: AuthState) => void }) {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="SignIn">{() => <SignInScreen onSignedIn={onSignedIn} />}</AuthStack.Screen>
    </AuthStack.Navigator>
  );
}

function PendingNavigator() {
  return (
    <PendingStack.Navigator screenOptions={{ headerShown: false }}>
      <PendingStack.Screen name="Pending">
        {() => <PlaceholderScreen title="Dossier en cours de validation" task="L6-15" />}
      </PendingStack.Screen>
    </PendingStack.Navigator>
  );
}

function DriverNavigator() {
  return (
    <DriverStack.Navigator initialRouteName="Home">
      <DriverStack.Screen name="Home">
        {() => <PlaceholderScreen title="Accueil chauffeur" task="L6-11" />}
      </DriverStack.Screen>
      <DriverStack.Screen name="Proposal" options={{ presentation: 'fullScreenModal' }}>
        {() => <PlaceholderScreen title="Proposition de course" task="L6-12" />}
      </DriverStack.Screen>
      <DriverStack.Screen name="ActiveRide">
        {() => <PlaceholderScreen title="Course en cours" task="L6-13" />}
      </DriverStack.Screen>
      <DriverStack.Screen name="Settlement">
        {() => <PlaceholderScreen title="Encaissement" task="L6-14" />}
      </DriverStack.Screen>
    </DriverStack.Navigator>
  );
}

/**
 * Un chauffeur `approved` accède aux écrans de course ; tout le reste -- `pending` (spécification
 * L6-00), `rejected`, `suspended`, ou un statut absent parce que le rafraîchissement de session a
 * échoué hors ligne -- est routé vers l'écran d'attente de dossier (critère d'acceptation 5).
 * Défaut-refus délibéré : seul `approved` est nommé explicitement, jamais l'inverse.
 */
function DriverAppSwitch({ user }: { user: AuthUser }) {
  if (user.driverStatus === 'approved') return <DriverNavigator />;
  return <PendingNavigator />;
}

export function AppNavigator() {
  const { session, handleSignedIn } = useSession();

  return (
    <NavigationContainer ref={navigationRef}>
      <AuthGate<AuthUser>
        session={session}
        renderLoading={() => <LoadingScreen />}
        renderSignedOut={() => <SignInStack onSignedIn={handleSignedIn} />}
        renderSignedIn={(user) => <DriverAppSwitch user={user} />}
      />
    </NavigationContainer>
  );
}
