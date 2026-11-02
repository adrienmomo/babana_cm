import React from 'react';
import { Image, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AuthUser } from '@babana/api-client';

let mockUser: AuthUser | null = null;
const mockSignOut = jest.fn();
jest.mock('../../auth', () => ({
  authClient: { getUser: () => mockUser },
  signOut: () => mockSignOut(),
}));

import { AccountScreen } from '../AccountScreen';

const AMINA: AuthUser = {
  id: 'u1',
  role: 'client',
  displayName: 'Amina Ngo',
  photoUrl: null,
  phoneVerified: true,
};

type Options = { headerRight?: () => React.ReactElement };

function fakeNavigation() {
  const options: Options = {};
  return {
    navigate: jest.fn(),
    setOptions: jest.fn((next: Options) => Object.assign(options, next)),
    options,
  };
}

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mockSignOut.mockReset();
  mockUser = null;
});

async function renderAccount(user: AuthUser | null = AMINA) {
  mockUser = user;
  const navigation = fakeNavigation();
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<AccountScreen navigation={navigation} route={{ key: 'Account', name: 'Account', params: undefined }} />);
  });
  roots.push(root);
  return { root, navigation };
}

/** Le bouton ⋮ vit dans la barre de navigation (`headerRight`) : rendu à part, comme la barre le ferait. */
async function renderHeaderRight(navigation: ReturnType<typeof fakeNavigation>) {
  const headerRight = navigation.options.headerRight;
  expect(headerRight).toBeDefined();
  let header!: ReactTestRenderer;
  await act(async () => {
    header = create(headerRight!());
  });
  roots.push(header);
  return header;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

describe('AccountScreen -- profil du client', () => {
  it('affiche le nom, les initiales faute de photo, et le numéro vérifié', async () => {
    const { root } = await renderAccount();

    expect(texts(root)).toContain('Amina Ngo');
    expect(root.root.findByProps({ testID: 'account-avatar-initials' }).props.children).toBe('AN');
    expect(texts(root)).toContain('Numéro de téléphone vérifié');
  });

  it('montre la photo quand il y en a une, et revient aux initiales si elle ne charge pas', async () => {
    const { root } = await renderAccount({ ...AMINA, photoUrl: 'https://example.test/amina.jpg' });

    const image = root.root.findByType(Image);
    expect(image.props.source).toEqual({ uri: 'https://example.test/amina.jpg' });
    expect(root.root.findAllByProps({ testID: 'account-avatar-initials' })).toHaveLength(0);

    await act(async () => {
      image.props.onError();
    });

    expect(root.root.findAllByType(Image)).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'account-avatar-initials' }).props.children).toBe('AN');
  });

  it('ne prétend pas que le numéro est vérifié quand il ne l’est pas', async () => {
    const { root } = await renderAccount({ ...AMINA, phoneVerified: false });
    expect(texts(root)).not.toContain('Numéro de téléphone vérifié');
  });

  it('« Mes courses » ouvre l’historique', async () => {
    const { root, navigation } = await renderAccount();

    await act(async () => {
      root.root.findByProps({ testID: 'account-row-history' }).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('History');
    expect(texts(root)).toContain('Mes courses');
  });

  it('le moyen de paiement est dit : espèces au chauffeur', async () => {
    const { root } = await renderAccount();
    expect(texts(root)).toContain('Paiement');
    expect(texts(root)).toContain('Espèces');
  });

  it('⋮ puis « Se déconnecter » demande confirmation avant de déconnecter', async () => {
    const { navigation } = await renderAccount();
    const header = await renderHeaderRight(navigation);

    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-button' }).props.onPress();
    });
    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-sign-out' }).props.onPress();
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(texts(header)).toContain('Se déconnecter de Babana ?');

    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-confirm-sign-out' }).props.onPress();
    });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('« Annuler » referme la confirmation sans déconnecter', async () => {
    const { navigation } = await renderAccount();
    const header = await renderHeaderRight(navigation);

    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-button' }).props.onPress();
    });
    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-sign-out' }).props.onPress();
    });
    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-cancel' }).props.onPress();
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(header.root.findAllByProps({ testID: 'account-menu-confirm-sign-out' })).toHaveLength(0);
  });
});
