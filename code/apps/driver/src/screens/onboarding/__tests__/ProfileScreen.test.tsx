import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ProfileScreen } from '../ProfileScreen';

const renderedRoots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function render(
  onContinue = jest.fn().mockResolvedValue(undefined),
  user: { displayName: string; photoUrl: string | null } = { displayName: 'Paul K.', photoUrl: null }
) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<ProfileScreen user={user} onContinue={onContinue} />);
  });
  renderedRoots.push(root);
  return { root, onContinue };
}

describe('ProfileScreen (L6-15)', () => {
  it("affiche l'identité issue de la connexion Google", async () => {
    const { root } = await render(undefined, { displayName: 'Paul K.', photoUrl: 'https://x/p.jpg' });
    expect(root.root.findByProps({ testID: 'profile-name' }).props.children).toBe('Paul K.');
    expect(root.root.findByProps({ testID: 'profile-avatar' }).props.source).toEqual({ uri: 'https://x/p.jpg' });
  });

  it('« Continuer » déclenche la confirmation du profil (persistée par l’appelant)', async () => {
    const { root, onContinue } = await render();
    await act(async () => {
      root.root.findByProps({ testID: 'profile-continue' }).props.onPress();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
