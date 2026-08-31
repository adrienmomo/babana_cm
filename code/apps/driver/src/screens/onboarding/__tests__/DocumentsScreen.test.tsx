jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';
import { DocumentsScreen } from '../DocumentsScreen';
import type { DocumentSlot } from '../state';
import type { ImageSource, PickImageOptions } from '../imageSource';

const MAX_BYTES = 4 * 1024 * 1024;

function slots(overrides: Partial<Record<'license' | 'id_card', DocumentSlot['status']>> = {}): DocumentSlot[] {
  return (['license', 'id_card'] as const).map((type) => ({
    type,
    status: overrides[type] ?? 'missing',
    rejectionReason: null,
    expiresOn: null,
  }));
}

function fakeImageSource(result: Awaited<ReturnType<ImageSource['pick']>> | Error): ImageSource & { calls: PickImageOptions[] } {
  const calls: PickImageOptions[] = [];
  return {
    calls,
    async pick(options) {
      calls.push(options);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const PICKED = { uri: 'file:///doc.jpg', name: 'doc.jpg', mimeType: 'image/jpeg', sizeBytes: 900_000 };

const renderedRoots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

interface Overrides {
  slots?: DocumentSlot[];
  imageSource?: ImageSource;
  uploader?: { upload: jest.Mock };
  pendingUploads?: Record<string, unknown>;
  onSavePending?: jest.Mock;
  onClearPending?: jest.Mock;
  onRefresh?: jest.Mock;
  onAllSubmitted?: jest.Mock;
  focusType?: 'license' | 'id_card';
}

async function render(o: Overrides = {}) {
  const props = {
    slots: o.slots ?? slots(),
    pendingUploads: (o.pendingUploads ?? {}) as never,
    imageSource: o.imageSource ?? fakeImageSource(PICKED),
    uploader: (o.uploader ?? { upload: jest.fn().mockResolvedValue({ id: 1, documentType: 'id_card', verificationStatus: 'pending' }) }) as never,
    maxBytes: MAX_BYTES,
    focusType: o.focusType,
    onSavePending: o.onSavePending ?? jest.fn().mockResolvedValue(undefined),
    onClearPending: o.onClearPending ?? jest.fn().mockResolvedValue(undefined),
    onRefresh: o.onRefresh ?? jest.fn().mockResolvedValue(undefined),
    onAllSubmitted: o.onAllSubmitted ?? jest.fn(),
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<DocumentsScreen {...props} />);
  });
  renderedRoots.push(root);
  return { root, props };
}

function press(root: ReactTestRenderer, testID: string) {
  return act(async () => {
    root.root.findByProps({ testID }).props.onPress();
  });
}
function typeText(root: ReactTestRenderer, testID: string, value: string) {
  return act(async () => {
    root.root.findByProps({ testID }).props.onChangeText(value);
  });
}
function allText(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

describe('DocumentsScreen (L6-15)', () => {
  it('critère 4 -- seulement permis et pièce d’identité, jamais de carte grise', async () => {
    const { root } = await render();
    expect(root.root.findByProps({ testID: 'doc-row-license' })).toBeTruthy();
    expect(root.root.findByProps({ testID: 'doc-row-id_card' })).toBeTruthy();
    expect(allText(root).toLowerCase()).not.toContain('carte grise');
  });

  it('critère 2 -- la prise de photo passe le plafond de taille à la compression', async () => {
    const imageSource = fakeImageSource(PICKED);
    const { root } = await render({ imageSource });
    await press(root, 'doc-camera-id_card');
    expect(imageSource.calls).toEqual([{ source: 'camera', maxBytes: MAX_BYTES }]);
  });

  it('critère 2 -- une photo encore trop lourde après compression n’est jamais envoyée', async () => {
    const heavy = { ...PICKED, sizeBytes: MAX_BYTES + 1 };
    const uploader = { upload: jest.fn() };
    const { root } = await render({ imageSource: fakeImageSource(heavy), uploader });
    await press(root, 'doc-camera-id_card');
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'doc-error-id_card' }).props.children).toMatch(/trop lourde/i);
  });

  it('dépôt réussi -- persiste la photo avant l’envoi, puis l’efface et relit le serveur', async () => {
    const onSavePending = jest.fn().mockResolvedValue(undefined);
    const onClearPending = jest.fn().mockResolvedValue(undefined);
    const onRefresh = jest.fn().mockResolvedValue(undefined);
    const uploader = { upload: jest.fn().mockResolvedValue({ id: 5, documentType: 'id_card', verificationStatus: 'pending' }) };
    const { root } = await render({ uploader, onSavePending, onClearPending, onRefresh });

    await press(root, 'doc-camera-id_card');

    expect(onSavePending).toHaveBeenCalledWith(expect.objectContaining({ type: 'id_card', uri: 'file:///doc.jpg' }));
    expect(uploader.upload).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: 'id_card', file: { uri: 'file:///doc.jpg', name: 'doc.jpg', mimeType: 'image/jpeg' } })
    );
    // Persistance AVANT l'envoi.
    expect(onSavePending.mock.invocationCallOrder[0]).toBeLessThan(uploader.upload.mock.invocationCallOrder[0]);
    expect(onClearPending).toHaveBeenCalledWith('id_card');
    expect(onRefresh).toHaveBeenCalled();
  });

  it('le permis exige sa date d’expiration avant tout envoi (L1-05 critère 5)', async () => {
    const uploader = { upload: jest.fn() };
    const { root } = await render({ uploader });

    await press(root, 'doc-camera-license');
    expect(uploader.upload).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'doc-error-license' }).props.children).toMatch(/date d'expiration/i);

    await typeText(root, 'doc-license-expiry', '2030-01-01');
    await press(root, 'doc-camera-license');
    expect(uploader.upload).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'license', expiresOn: '2030-01-01' }));
  });

  it('coupure réseau -- la photo reste conservée, un bouton la renvoie sans reprise (spécification)', async () => {
    const onClearPending = jest.fn().mockResolvedValue(undefined);
    const upload = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ id: 6, documentType: 'id_card', verificationStatus: 'pending' });
    const { root } = await render({
      uploader: { upload },
      onClearPending,
      pendingUploads: { id_card: { type: 'id_card', uri: 'file:///doc.jpg', name: 'doc.jpg', mimeType: 'image/jpeg' } },
    });

    await press(root, 'doc-camera-id_card');
    // Envoi interrompu : rien n'a été effacé, un bouton « Réessayer l'envoi » apparaît.
    expect(onClearPending).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'doc-error-id_card' }).props.children).toMatch(/interrompu/i);

    await press(root, 'doc-retry-id_card');
    // Renvoi du même fichier, sans nouvelle prise de photo.
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0]).toEqual(upload.mock.calls[0][0]);
    expect(onClearPending).toHaveBeenCalledWith('id_card');
  });

  it('erreur métier (type MIME) -- le fichier est abandonné, message affiché, pas de bouton de renvoi', async () => {
    const onClearPending = jest.fn().mockResolvedValue(undefined);
    const upload = jest.fn().mockRejectedValue(new ApiError('DOCUMENT_TYPE_MISMATCH', 'mismatch', 400));
    const { root } = await render({ uploader: { upload }, onClearPending });

    await press(root, 'doc-camera-id_card');

    expect(onClearPending).toHaveBeenCalledWith('id_card');
    expect(root.root.findAllByProps({ testID: 'doc-retry-id_card' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'doc-error-id_card' })).toBeTruthy();
  });

  it('critère 3 -- un document rejeté affiche son motif, et sa ligne est indépendante', async () => {
    const { root } = await render({
      slots: [
        { type: 'license', status: 'rejected', rejectionReason: 'Photo floue', expiresOn: null },
        { type: 'id_card', status: 'verified', rejectionReason: null, expiresOn: null },
      ],
    });
    expect(root.root.findByProps({ testID: 'doc-reason-license' }).props.children).toContain('Photo floue');
    expect(root.root.findByProps({ testID: 'doc-status-license' }).props.children).toMatch(/renvoyer/i);
    expect(root.root.findByProps({ testID: 'doc-status-id_card' }).props.children).toMatch(/valid/i);
    // Chaque ligne a ses propres contrôles : renvoyer le permis n'affecte pas la pièce d'identité.
    expect(root.root.findByProps({ testID: 'doc-camera-license' })).toBeTruthy();
    expect(root.root.findByProps({ testID: 'doc-camera-id_card' })).toBeTruthy();
    // Le motif ne s'affiche que sur la ligne rejetée.
    expect(root.root.findAllByProps({ testID: 'doc-reason-id_card' })).toHaveLength(0);
  });

  it('quand tout est déposé, l’écran fait avancer vers l’attente de validation', async () => {
    const onAllSubmitted = jest.fn();
    await render({
      slots: [
        { type: 'license', status: 'pending', rejectionReason: null, expiresOn: '2030-01-01' },
        { type: 'id_card', status: 'verified', rejectionReason: null, expiresOn: null },
      ],
      onAllSubmitted,
    });
    expect(onAllSubmitted).toHaveBeenCalledTimes(1);
  });

  it('focusType met la ligne concernée en avant', async () => {
    const { root } = await render({ focusType: 'license' });
    expect(root.root.findByProps({ testID: 'doc-row-license' }).props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ borderColor: '#0A7D3D' })])
    );
  });
});
