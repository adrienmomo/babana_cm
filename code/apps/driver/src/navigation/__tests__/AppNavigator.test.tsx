import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../../bootstrap', () => ({ bootstrap: jest.fn() }));

let sessionLostListener: (() => void) | null = null;
jest.mock('../../auth', () => ({
  authClient: { restore: jest.fn(), refresh: jest.fn() },
  onSessionLost: (listener: () => void) => {
    sessionLostListener = listener;
    return () => {
      sessionLostListener = null;
    };
  },
}));

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
const mockRefresh = authClient.refresh as jest.Mock;

function driverUser(driverStatus: 'pending' | 'approved' | 'rejected' | 'suspended' | undefined) {
  return { id: 'd1', role: 'driver' as const, displayName: 'Paul', photoUrl: null, phoneVerified: true, driverStatus };
}

async function renderApp(): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<AppNavigator />);
  });
  return root;
}

describe('AppNavigator Chauffeur (L6-00)', () => {
  afterEach(() => {
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

  it("un chauffeur pending n'atteint pas les écrans de course -- il est routé vers l'attente de dossier (critère 5)", async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefresh.mockResolvedValue({ user: driverUser('pending') });
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Dossier en cours de validation');
    expect(texts.join(' ')).not.toContain('Accueil chauffeur');
  });

  it.each(['rejected', 'suspended', undefined] as const)(
    'un chauffeur %s (défaut-refus) est aussi routé vers l\'attente de dossier',
    async (status) => {
      mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
      mockRefresh.mockResolvedValue({ user: driverUser(status) });
      const root = await renderApp();

      const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
      expect(texts.join(' ')).toContain('Dossier en cours de validation');
    }
  );

  it('un chauffeur approved atteint les écrans de course', async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefresh.mockResolvedValue({ user: driverUser('approved') });
    const root = await renderApp();

    const texts = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children));
    expect(texts.join(' ')).toContain('Accueil chauffeur');
  });

  it("la perte de session en cours d'usage ramène à la connexion depuis les écrans de course (critère 4)", async () => {
    mockRestore.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    mockRefresh.mockResolvedValue({ user: driverUser('approved') });
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
