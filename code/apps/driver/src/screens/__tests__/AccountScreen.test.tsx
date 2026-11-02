import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AuthUser } from '@babana/api-client';
import type { http } from '@babana/contracts';

let mockUser: AuthUser | null = null;
const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  authClient: { getUser: () => mockUser },
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
});

async function renderAccount(user: AuthUser | null = EMMANUEL) {
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
});
