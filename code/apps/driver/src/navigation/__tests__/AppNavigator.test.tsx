import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../../bootstrap', () => ({ bootstrap: jest.fn() }));

let sessionLostListener: (() => void) | null = null;
jest.mock('../../auth', () => ({
  authClient: { restore: jest.fn(), refreshUser: jest.fn() },
  // Jamais réellement exercé -- authClient.refreshUser est mocké au-dessus, l'objet n'a besoin
  // que d'exister pour l'argument que `useSession` (index.tsx) lui passe (D35).
  apiClient: {},
  onSessionLost: (listener: () => void) => {
    sessionLostListener = listener;
    return () => {
      sessionLostListener = null;
    };
  },
}));

// HomeScreen (L6-11) a ses propres tests (HomeScreen.test.tsx) -- ici, seul l'aiguillage de
// navigation compte, même raison que le mock de SignInScreen ci-dessous : un écran métier réel
// ouvrirait une connexion temps réel, hors du périmètre de ce fichier.
jest.mock('../../screens/HomeScreen', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { HomeScreen: () => <RNText>Accueil chauffeur</RNText> };
});

jest.mock('../../screens/SignInScreen', () => {
  const { Text: RNText, Pressable } = jest.requireActual('react-native');
  return {
    SignInScreen: ({ onSignedIn }: { onSignedIn: (session: unknown) => void }) => (
      <Pressable
        accessibilityRole="button"
        testID="fake-sign-in"
        onPress={() =>
          onSignedIn({
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: Date.now() + 3600_000,
            user: { id: 'd1', role: 'driver', displayName: 'Paul', photoUrl: null, phoneVerified: true, driverStatus: 'approved' },
          })
        }
      >
        <RNText>sign-in-screen</RNText>
      </Pressable>
    ),
  };
});

import { authClient } from '../../auth';
import { AppNavigator, navigationRef } from '../index';

const mockRestore = authClient.restore as jest.Mock;
const mockRefreshUser = authClient.refreshUser as jest.Mock;

function driverUser(driverStatus: 'pending' | 'approved' | 'rejected' | 'suspended' | undefined) {
  return { id: 'd1', role: 'driver' as const, displayName: 'Paul', photoUrl: null, phoneVerified: true, driverStatus };
}

const renderedRoots: ReactTestRenderer[] = [];

async function renderApp(): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<AppNavigator />);
  });
  renderedRoots.push(root);
  return root;
}

describe('AppNavigator Chauffeur (L6-00)', () => {
  afterEach(async () => {
    // Démonter les arbres rendus : depuis L6-15, l'écran d'inscription porte un effet
    // asynchrone (useOnboarding) -- un arbre laissé monté ferait fuir un setState après la fin
    // du test ("worker process failed to exit gracefully").
    await act(async () => {
      for (const root of renderedRoots.splice(0)) root.unmount();
    });
    jest.clearAllMocks();
    sessionLostListener = null;
  });

  it("sans session, seul l'écran de connexion est monté (critère 3)", async () => {
    mockRestore.mockResolvedValue(null);
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('sign-in-screen');
    expect(texts.join(' ')).not.toContain('Accueil chauffeur');
  });

  it("sans session, naviguer directement vers un écran de course ne l'affiche pas (critère 3)", async () => {
    mockRestore.mockResolvedValue(null);
    const root = await renderApp();

    await act(async () => {
      navigationRef.navigate('Home' as never);
    });

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).not.toContain('Accueil chauffeur');
  });

  // Depuis L6-15, le chauffeur non approuvé entre dans le parcours d'inscription réel (profil,
  // dépôt des pièces, attente) au lieu du placeholder L6-00. Sans état local ni serveur (mocks
  // ci-dessus), l'écran d'entrée calculé est le profil -- ce qui reste vérifié ici, c'est le
  // critère 5 de L6-00 : il n'atteint aucun écran de course.
  it("un chauffeur pending n'atteint pas les écrans de course -- il entre dans le parcours d'inscription (critère 5)", async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefreshUser.mockResolvedValue({ user: driverUser('pending') });
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Votre inscription');
    expect(texts.join(' ')).not.toContain('Accueil chauffeur');
  });

  it.each(['rejected', 'suspended', undefined] as const)(
    "un chauffeur %s (défaut-refus) entre aussi dans le parcours d'inscription, jamais dans les écrans de course",
    async (status) => {
      mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
      mockRefreshUser.mockResolvedValue({ user: driverUser(status) });
      const root = await renderApp();

      const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
      expect(texts.join(' ')).toContain('Votre inscription');
      expect(texts.join(' ')).not.toContain('Accueil chauffeur');
    }
  );

  it('un chauffeur approved atteint les écrans de course', async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefreshUser.mockResolvedValue({ user: driverUser('approved') });
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Accueil chauffeur');
  });

  it("la perte de session en cours d'usage ramène à la connexion depuis les écrans de course (critère 4)", async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefreshUser.mockResolvedValue({ user: driverUser('approved') });
    const root = await renderApp();
    expect(root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ')).toContain(
      'Accueil chauffeur'
    );

    await act(async () => {
      sessionLostListener?.();
    });

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('sign-in-screen');
    expect(texts.join(' ')).not.toContain('Accueil chauffeur');
  });
});
