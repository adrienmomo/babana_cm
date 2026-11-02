import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AuthUser } from '@babana/api-client';
import type { http } from '@babana/contracts';

let mockUser: AuthUser | null = null;
// Le profil relit `GET /me` à l'ouverture (la note bouge après chaque course) ; par défaut, le
// serveur renvoie le même profil que la session.
const mockRefreshUser = jest.fn();
const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  authClient: { getUser: () => mockUser, refreshUser: (...args: unknown[]) => mockRefreshUser(...args) },
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const mockSignOutDriver = jest.fn();
jest.mock('../../signOut', () => ({
  signOutDriver: () => mockSignOutDriver(),
}));

import { AccountScreen } from '../AccountScreen';

const EMMANUEL: AuthUser = {
  id: 'd1',
  role: 'driver',
  displayName: 'Emmanuel Ebongue',
  photoUrl: null,
  phoneVerified: true,
  rating: { average: null, count: 0 },
  driverStatus: 'approved',
  driverRejectionReason: null,
};

function doc(overrides: Partial<http.DriverDocument>): http.DriverDocument {
  return {
    id: 1,
    documentType: 'license',
    verificationStatus: 'verified',
    rejectionReason: null,
    expiresOn: '2027-03-12',
    uploadedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

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
  mockRequest.mockReset();
  mockSignOutDriver.mockReset();
  mockUser = null;
  mockRefreshUser.mockReset();
});

async function renderAccount(user: AuthUser | null = EMMANUEL, fresh: AuthUser | null = user) {
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

async function openSignOutConfirmation(header: ReactTestRenderer) {
  await act(async () => {
    header.root.findByProps({ testID: 'account-menu-button' }).props.onPress();
  });
  await act(async () => {
    header.root.findByProps({ testID: 'account-menu-sign-out' }).props.onPress();
  });
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

describe('AccountScreen -- profil du chauffeur', () => {
  it('affiche le nom, les initiales faute de photo, et le compte validé', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
    const { root } = await renderAccount();

    expect(texts(root)).toContain('Emmanuel Ebongue');
    expect(root.root.findByProps({ testID: 'account-avatar-initials' }).props.children).toBe('EE');
    expect(texts(root)).toContain('Compte chauffeur validé');
  });

  it('« Ma caisse » est dans la liste et ouvre la recette', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
    const { root, navigation } = await renderAccount();

    await act(async () => {
      root.root.findByProps({ testID: 'account-row-cash' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Cash');
  });

  it('« Mes documents » : chaque pièce avec son état et, pour le permis, sa date d’expiration', async () => {
    mockRequest.mockResolvedValue({
      documents: [doc({}), doc({ id: 2, documentType: 'id_card', expiresOn: null })],
    });
    const { root } = await renderAccount();

    expect(mockRequest).toHaveBeenCalledWith('listDriverDocuments');
    const license = root.root.findByProps({ testID: 'account-document-license' });
    const idCard = root.root.findByProps({ testID: 'account-document-id_card' });
    const textsOf = (node: typeof license) =>
      node.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
    expect(textsOf(license)).toContain('Permis de conduire');
    expect(textsOf(license)).toContain('Validé');
    expect(textsOf(license)).toContain('expire le 12/03/2027');
    expect(textsOf(idCard)).toContain("Pièce d'identité");
    expect(textsOf(idCard)).toContain('Validé');
    expect(textsOf(idCard)).not.toContain('expire');
  });

  it('un document refusé dit son motif', async () => {
    mockRequest.mockResolvedValue({
      documents: [doc({ verificationStatus: 'rejected', rejectionReason: 'Photo illisible' })],
    });
    const { root } = await renderAccount();

    expect(texts(root)).toContain('Refusé');
    expect(texts(root)).toContain('Photo illisible');
  });

  it('hors connexion, la section des documents le dit au lieu de rester vide', async () => {
    mockRequest.mockRejectedValue(new TypeError('Network request failed'));
    const { root } = await renderAccount();

    expect(root.root.findAllByProps({ testID: 'account-documents-error' }).length).toBeGreaterThan(0);
    expect(texts(root)).toContain('Documents indisponibles pour le moment');
  });

  it('⋮ puis « Se déconnecter », confirmé : la déconnexion du chauffeur part', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
    mockSignOutDriver.mockResolvedValue({ signedOut: true });
    const { navigation } = await renderAccount();
    const header = await renderHeaderRight(navigation);

    await openSignOutConfirmation(header);
    expect(mockSignOutDriver).not.toHaveBeenCalled();
    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-confirm-sign-out' }).props.onPress();
    });

    expect(mockSignOutDriver).toHaveBeenCalledTimes(1);
  });

  it('une déconnexion refusée par le serveur (course en cours) affiche son motif, le menu reste ouvert', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
    mockSignOutDriver.mockResolvedValue({ signedOut: false, message: 'Terminez la course en cours avant de passer hors ligne.' });
    const { navigation } = await renderAccount();
    const header = await renderHeaderRight(navigation);

    await openSignOutConfirmation(header);
    await act(async () => {
      header.root.findByProps({ testID: 'account-menu-confirm-sign-out' }).props.onPress();
    });

    expect(header.root.findByProps({ testID: 'account-menu-error' }).props.children).toBe(
      'Terminez la course en cours avant de passer hors ligne.'
    );
  });

  describe('sa note (2 novembre)', () => {
    it('affiche la moyenne reçue et le nombre d’avis', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
      const { root } = await renderAccount({ ...EMMANUEL, rating: { average: 4.7, count: 12 } });
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,7 · 12 avis');
    });

    it('sous le seuil d’avis, « Nouveau » plutôt qu’une note', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
      const { root } = await renderAccount({ ...EMMANUEL, rating: { average: null, count: 2 } });
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('Nouveau · 2 avis');
    });

    it('sans aucun avis, le dit -- jamais une note de zéro', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
      const { root } = await renderAccount();
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('Pas encore d’avis');
    });

    it('la note est relue au serveur à l’ouverture : celle de la session date du démarrage', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
      const { root } = await renderAccount(EMMANUEL, { ...EMMANUEL, rating: { average: 4.5, count: 3 } });
      expect(mockRefreshUser).toHaveBeenCalled();
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,5 · 3 avis');
    });

    it('hors connexion, garde la note de la session', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
      const { root } = await renderAccount({ ...EMMANUEL, rating: { average: 4.2, count: 5 } }, null);
      expect(root.root.findByProps({ testID: 'account-rating' }).props.children).toBe('★ 4,2 · 5 avis');
    });
  });

  it('« Mes courses » ouvre l’historique du chauffeur, où il corrige ses notes', async () => {
    mockRequest.mockResolvedValue({ documents: [] });
    const { root, navigation } = await renderAccount();

    await act(async () => {
      root.root.findByProps({ testID: 'account-row-history' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('RideHistory');
  });
});
