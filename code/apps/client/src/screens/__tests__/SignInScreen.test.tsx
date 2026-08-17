import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

jest.mock('../../auth', () => ({
  authClient: { exchangeGoogleIdToken: jest.fn() },
}));
jest.mock('@babana/api-client', () => {
  const actual = jest.requireActual('@babana/api-client');
  return { ...actual, signInWithGoogleNative: jest.fn() };
});

import { signInWithGoogleNative, GooglePlayServicesUnavailableError, GoogleSignInCancelledError } from '@babana/api-client';
import { authClient } from '../../auth';
import { SignInScreen } from '../SignInScreen';

const mockSignIn = signInWithGoogleNative as jest.Mock;
const mockExchange = authClient.exchangeGoogleIdToken as jest.Mock;

describe('SignInScreen (app Client, L6-02)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('échange l\'ID token contre une session client et prévient l\'appelant', async () => {
    mockSignIn.mockResolvedValue('id-token');
    mockExchange.mockResolvedValue({ user: { role: 'client' } });
    const onSignedIn = jest.fn();
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={onSignedIn} />);
    });

    await act(async () => {
      root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(mockExchange).toHaveBeenCalledWith('id-token', 'client');
    expect(onSignedIn).toHaveBeenCalledWith({ user: { role: 'client' } });
  });

  it('affiche un message clair si Google Play Services est indisponible', async () => {
    mockSignIn.mockRejectedValue(new GooglePlayServicesUnavailableError());
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={jest.fn()} />);
    });

    await act(async () => {
      root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    const texts = root!.root.findAllByType(Text).map((node) => node.props.children);
    expect(texts.join(' ')).toContain('Google Play Services');
  });

  it('une annulation volontaire ne produit aucun message d\'erreur', async () => {
    mockSignIn.mockRejectedValue(new GoogleSignInCancelledError());
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={jest.fn()} />);
    });

    await act(async () => {
      root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    const texts = root!.root.findAllByType(Text).map((node) => node.props.children);
    expect(texts.join(' ')).not.toContain('échoué');
  });
});
