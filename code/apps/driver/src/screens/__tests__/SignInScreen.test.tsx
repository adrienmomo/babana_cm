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

import { signInWithGoogleNative, GooglePlayServicesUnavailableError } from '@babana/api-client';
import { authClient } from '../../auth';
import { SignInScreen } from '../SignInScreen';

const mockSignIn = signInWithGoogleNative as jest.Mock;
const mockExchange = authClient.exchangeGoogleIdToken as jest.Mock;

describe('SignInScreen (app Chauffeur, L6-02)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('échange l\'ID token avec le rôle "driver", jamais "client"', async () => {
    mockSignIn.mockResolvedValue('id-token');
    mockExchange.mockResolvedValue({ user: { role: 'driver', driverStatus: 'approved' } });
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={jest.fn()} />);
    });

    await act(async () => {
      root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(mockExchange).toHaveBeenCalledWith('id-token', 'driver');
  });

  it(
    'critère d\'acceptation 5 : un chauffeur pending reçoit tout de même sa session, ' +
      'ce n\'est jamais traité comme une erreur',
    async () => {
      mockSignIn.mockResolvedValue('id-token');
      mockExchange.mockResolvedValue({ user: { role: 'driver', driverStatus: 'pending' } });
      const onSignedIn = jest.fn();
      let root: ReturnType<typeof create>;
      await act(async () => {
        root = create(<SignInScreen onSignedIn={onSignedIn} />);
      });

      await act(async () => {
        root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
      });

      expect(onSignedIn).toHaveBeenCalledWith({ user: { role: 'driver', driverStatus: 'pending' } });
      expect(root!.root.findAllByType(Text).map((node) => node.props.children).join(' ')).not.toContain('échoué');
    }
  );

  it('affiche un message clair si Google Play Services est indisponible', async () => {
    mockSignIn.mockRejectedValue(new GooglePlayServicesUnavailableError());
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={jest.fn()} />);
    });

    await act(async () => {
      root!.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(root!.root.findAllByType(Text).map((node) => node.props.children).join(' ')).toContain(
      'Google Play Services'
    );
  });
});
