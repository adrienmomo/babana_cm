import React from 'react';
import { Image, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AuthUser } from '@babana/api-client';

let mockUser: AuthUser | null = null;
// Le profil relit `GET /me` à l'ouverture (la note bouge après chaque course) ; par défaut, le
// serveur renvoie le même profil que la session.
const mockRefreshUser = jest.fn();
const mockSignOut = jest.fn();
jest.mock('../../auth', () => ({
  authClient: { getUser: () => mockUser, refreshUser: (...args: unknown[]) => mockRefreshUser(...args) },
  apiClient: {},
  signOut: () => mockSignOut(),
}));

import { AccountScreen } from '../AccountScreen';

const AMINA: AuthUser = {
  id: 'u1',
  role: 'client',
  displayName: 'Amina Ngo',
  photoUrl: null,
  phoneVerified: true,
  rating: { average: null, count: 0 },
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
  mockRefreshUser.mockReset();
});

async function renderAccount(user: AuthUser | null = AMINA, fresh: AuthUser | null = user) {
  mockUser = user;
  if (fresh) mockRefreshUser.mockResolvedValue({ user: fresh });
  else mockRefreshUser.mockRejectedValue(new TypeError('Network request failed'));
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

  describe('sa note (2 novembre)', () => {
    it('affiche la moyenne reçue et le nombre d’avis', async () => {
      const { root } = await renderAccount({ ...AMINA, rating: { average: 4.7, count: 12 } });
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,7 · 12 avis');
    });

    it('sous le seuil d’avis, « Nouveau » plutôt qu’une note', async () => {
      const { root } = await renderAccount({ ...AMINA, rating: { average: null, count: 2 } });
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('Nouveau · 2 avis');
    });

    it('sans aucun avis, le dit -- jamais une note de zéro', async () => {
      const { root } = await renderAccount();
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('Pas encore d’avis');
    });

    it('la note est relue au serveur à l’ouverture : celle de la session date du démarrage', async () => {
      const { root } = await renderAccount(AMINA, { ...AMINA, rating: { average: 4.5, count: 3 } });
      expect(mockRefreshUser).toHaveBeenCalled();
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,5 · 3 avis');
    });

    it('hors connexion, garde la note de la session', async () => {
      const { root } = await renderAccount({ ...AMINA, rating: { average: 4.2, count: 5 } }, null);
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,2 · 5 avis');
    });
  });
});
