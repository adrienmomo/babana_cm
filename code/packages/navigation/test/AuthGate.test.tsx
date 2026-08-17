import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AuthGate } from '../src/AuthGate';
import type { SessionState } from '../src/session';

interface FakeUser {
  id: string;
}

function gate(session: SessionState<FakeUser>) {
  return (
    <AuthGate<FakeUser>
      session={session}
      renderLoading={() => <Text>loading</Text>}
      renderSignedOut={() => <Text>sign-in</Text>}
      renderSignedIn={(user) => <Text>home-{user.id}</Text>}
    />
  );
}

async function renderGate(session: SessionState<FakeUser>): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(gate(session));
  });
  return root;
}

describe('AuthGate (L6-00, critères 3 et 4)', () => {
  it('ne monte que renderLoading tant que la session est en cours de lecture', async () => {
    const root = await renderGate({ status: 'loading' });
    expect(root.root.findAllByType(Text).map((n) => n.props.children)).toEqual(['loading']);
  });

  it("ne monte que renderSignedOut sans session -- aucun écran métier n'existe dans l'arbre", async () => {
    const root = await renderGate({ status: 'unauthenticated' });
    const texts = root.root.findAllByType(Text).map((n) => n.props.children);
    expect(texts).toEqual(['sign-in']);
    expect(texts.join(' ')).not.toContain('home-');
  });

  it('ne monte que renderSignedIn avec une session valide, avec le user fourni', async () => {
    const root = await renderGate({ status: 'authenticated', user: { id: 'u1' } });
    expect(root.root.findAllByType(Text).map((n) => n.props.children)).toEqual([['home-', 'u1']]);
  });

  it("démonte le sous-arbre authentifié et remonte renderSignedOut quand la session est perdue en cours d'usage", async () => {
    const root = await renderGate({ status: 'authenticated', user: { id: 'u1' } });
    expect(root.root.findAllByType(Text).map((n) => n.props.children)).toEqual([['home-', 'u1']]);

    await act(async () => {
      root.update(gate({ status: 'unauthenticated' }));
    });

    const texts = root.root.findAllByType(Text).map((n) => n.props.children);
    expect(texts).toEqual(['sign-in']);
    expect(texts.join(' ')).not.toContain('home-');
  });
});
