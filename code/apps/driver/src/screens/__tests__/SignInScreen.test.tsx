import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import { SignInScreen } from '../SignInScreen';

describe('SignInScreen (app Chauffeur) -- Google Sign-In retiré', () => {
  it("n'offre plus de bouton de connexion Google", async () => {
    let root: ReturnType<typeof create>;
    await act(async () => {
      root = create(<SignInScreen onSignedIn={jest.fn()} />);
    });

    expect(root!.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
    const texts = root!.root.findAllByType(Text).map((node) => String(node.props.children)).join(' ');
    expect(texts).not.toMatch(/google/i);
    expect(texts).toContain('numéro de téléphone');
  });
});
