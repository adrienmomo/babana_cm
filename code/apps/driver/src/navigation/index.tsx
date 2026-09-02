import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthGate, PlaceholderScreen, type SessionState } from '@babana/navigation';
import { ApiError, type AuthState, type AuthUser } from '@babana/api-client';
import { apiClient, authClient, onSessionLost } from '../auth';
import { bootstrap } from '../bootstrap';
import { SignInScreen } from '../screens/SignInScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { ProposalScreen } from '../screens/ProposalScreen';
import { ActiveRideScreen } from '../screens/ActiveRideScreen';
import { SettlementScreen } from '../screens/SettlementScreen';
import { CashScreen } from '../screens/CashScreen';
import { RemittanceScreen } from '../screens/RemittanceScreen';
import { ProfileScreen } from '../screens/onboarding/ProfileScreen';
import { DocumentsScreen } from '../screens/onboarding/DocumentsScreen';
import { PendingScreen } from '../screens/onboarding/PendingScreen';
import { RejectedScreen } from '../screens/onboarding/RejectedScreen';
import { defaultImageSource } from '../screens/onboarding/imageSource';
import { useOnboarding } from '../screens/onboarding/useOnboarding';
import { documentUploader } from '../onboarding';
import { ONBOARDING_MAX_DOCUMENT_BYTES } from '../../config';
import { navigationRef } from './ref';
import type { AuthParamList, DriverParamList, DriverOnboardingParamList } from './types';

// Réexporté d'ici : posé à l'origine dans ce module, `navigation/__tests__/AppNavigator.test.tsx`
// et d'anciens imports le prennent encore ici. La définition vit dans `./ref` (voir ce fichier).
export { navigationRef };

const AuthStack = createNativeStackNavigator<AuthParamList>();
const DriverStack = createNativeStackNavigator<DriverParamList>();
const OnboardingStack = createNativeStackNavigator<DriverOnboardingParamList>();

/**
 * Racine de navigation de l'app Chauffeur (L6-00) -- même bootstrap de session que
 * apps/client/src/navigation/index.tsx (voir ce fichier pour le détail du raisonnement sur
 * `GET /me`, D35). Ici, ce rafraîchissement compte particulièrement : c'est lui qui donne un
 * `driverStatus` à jour dès l'ouverture de l'app, avant même le premier écran.
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
          // appelle onSessionLost() -- l'abonnement ci-dessous fera passer session à
          // 'unauthenticated'.
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

/**
 * Parcours d'inscription et de suivi de dossier (L6-15) : profil -> dépôt des pièces -> écran
 * d'attente, plus l'écran de dossier refusé (amoa/questions/REPONSES-2026-09-04.md §2). L'écran
 * d'entrée est calculé à l'ouverture depuis l'état serveur (`useOnboarding`, qui prend
 * `driverStatus` en compte) -- rouvrir l'app après une fermeture retombe sur la bonne étape
 * (critère 1). Les écrans ne lisent jamais le serveur eux-mêmes : ils reçoivent `slots`, le
 * motif de refus et les gestes en props.
 */
function OnboardingNavigator({ user }: { user: AuthUser }) {
  const onboarding = useOnboarding(user.id, user.driverStatus);
  // Sûr par construction : `Rejected` n'est l'écran d'entrée que quand `driverStatus` vaut
  // 'rejected' ou 'suspended' (resolveOnboardingRoute) -- le repli 'rejected' ne sert qu'à
  // satisfaire le typage.
  const rejectedStatus: 'rejected' | 'suspended' = user.driverStatus === 'suspended' ? 'suspended' : 'rejected';

  if (onboarding.status === 'loading') {
    return <PlaceholderScreen title="Babana Chauffeur" task="chargement du dossier" />;
  }

  return (
    <OnboardingStack.Navigator initialRouteName={onboarding.initialRoute} screenOptions={{ headerShown: false }}>
      <OnboardingStack.Screen name="Profile">
        {({ navigation }) => (
          <ProfileScreen
            user={{ displayName: user.displayName, photoUrl: user.photoUrl }}
            onContinue={async () => {
              await onboarding.acknowledgeProfile();
              navigation.replace('Documents');
            }}
          />
        )}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Documents">
        {({ navigation, route }) => (
          <DocumentsScreen
            slots={onboarding.slots}
            pendingUploads={onboarding.pendingUploads}
            imageSource={defaultImageSource}
            uploader={documentUploader}
            maxBytes={ONBOARDING_MAX_DOCUMENT_BYTES}
            focusType={route.params?.focusType}
            onSavePending={onboarding.savePending}
            onClearPending={onboarding.clearPending}
            onRefresh={onboarding.refresh}
            onAllSubmitted={() => navigation.replace('Pending')}
          />
        )}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Pending">
        {({ navigation }) => (
          <PendingScreen
            slots={onboarding.slots}
            onFix={(type) => navigation.navigate('Documents', { focusType: type })}
            onRefresh={onboarding.refresh}
          />
        )}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Rejected">
        {({ navigation }) => (
          <RejectedScreen
            status={rejectedStatus}
            reason={user.driverRejectionReason ?? null}
            onResubmit={() => navigation.navigate('Documents')}
          />
        )}
      </OnboardingStack.Screen>
    </OnboardingStack.Navigator>
  );
}

function DriverNavigator() {
  return (
    <DriverStack.Navigator initialRouteName="Home">
      <DriverStack.Screen name="Home" component={HomeScreen} />
      <DriverStack.Screen name="Proposal" component={ProposalScreen} options={{ presentation: 'fullScreenModal' }} />
      <DriverStack.Screen name="ActiveRide" component={ActiveRideScreen} options={{ headerShown: false, gestureEnabled: false }} />
      <DriverStack.Screen name="Settlement" component={SettlementScreen} options={{ headerShown: false, gestureEnabled: false }} />
      <DriverStack.Screen name="Cash" component={CashScreen} options={{ title: 'Ma caisse' }} />
      <DriverStack.Screen name="Remittance" component={RemittanceScreen} options={{ title: 'Déclarer une remise' }} />

    </DriverStack.Navigator>
  );
}

/**
 * Un chauffeur `approved` accède aux écrans de course ; tout le reste -- `pending` (spécification
 * L6-00), `rejected`, `suspended`, ou un statut absent parce que le rafraîchissement de session a
 * échoué hors ligne -- est routé vers le parcours d'inscription / suivi de dossier (L6-15).
 * Défaut-refus délibéré : seul `approved` est nommé explicitement, jamais l'inverse.
 */
function DriverAppSwitch({ user }: { user: AuthUser }) {
  if (user.driverStatus === 'approved') return <DriverNavigator />;
  return <OnboardingNavigator user={user} />;
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
