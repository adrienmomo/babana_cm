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

// HomeScreen (L6-06) a ses propres tests (HomeScreen.test.tsx) -- ici, seul l'aiguillage de
// navigation compte, même raison que le mock de SignInScreen ci-dessous : un écran métier réel
// ouvrirait une connexion temps réel et demanderait la position GPS, hors du périmètre de ce
// fichier.
jest.mock('../../screens/HomeScreen', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { HomeScreen: () => <RNText>Accueil</RNText> };
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
            user: { id: 'u1', role: 'client', displayName: 'Amina', photoUrl: null, phoneVerified: true },
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

async function renderApp(): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<AppNavigator />);
  });
  return root;
}

describe('AppNavigator Client (L6-00)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    sessionLostListener = null;
  });

  it("sans session, seul l'écran de connexion est monté -- aucun écran métier n'existe dans l'arbre (critère 3)", async () => {
    mockRestore.mockResolvedValue(null);
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('sign-in-screen');
    expect(texts.join(' ')).not.toContain('Accueil');
  });

  it("sans session, naviguer directement vers un écran métier ne l'affiche pas (critère 3)", async () => {
    mockRestore.mockResolvedValue(null);
    const root = await renderApp();

    // Le navigateur monté est AuthStack (seule route : "SignIn") -- "Home" n'y existe pas.
    // React Navigation journalise un avertissement et ne fait rien, plutôt que de planter.
    await act(async () => {
      navigationRef.navigate('Home' as never);
    });

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('sign-in-screen');
    expect(texts.join(' ')).not.toContain('Accueil');
  });

  it('une session déjà valide au démarrage monte directement les écrans métier', async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefreshUser.mockResolvedValue({
      user: { id: 'u1', role: 'client', displayName: 'Amina', photoUrl: null, phoneVerified: true },
    });
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Accueil');
  });

  it('la connexion fait apparaître les écrans métier', async () => {
    mockRestore.mockResolvedValue(null);
    const root = await renderApp();

    await act(async () => {
      root.root.findByProps({ testID: 'fake-sign-in' }).props.onPress();
    });

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Accueil');
  });

  it("la perte de session en cours d'usage ramène à la connexion, depuis n'importe quel écran (critère 4)", async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefreshUser.mockResolvedValue({
      user: { id: 'u1', role: 'client', displayName: 'Amina', photoUrl: null, phoneVerified: true },
    });
    const root = await renderApp();
    expect(root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ')).toContain('Accueil');

    await act(async () => {
      sessionLostListener?.();
    });

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('sign-in-screen');
    expect(texts.join(' ')).not.toContain('Accueil');
  });
});
