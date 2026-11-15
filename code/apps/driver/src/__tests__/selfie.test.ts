import { takeSelfie, type SelfieDeps } from '../selfie';

// 15 novembre : selfie de contrôle -- appareil photo avant, jamais la galerie.

const STATUS = { due: false, lastState: 'pending' as const, rejectionReason: null, dueAt: '2026-11-16T08:00:00+00:00', intervalHours: 24 };

function deps(picked: unknown): SelfieDeps & { pick: jest.Mock; upload: jest.Mock } {
  const pick = jest.fn().mockResolvedValue(picked);
  const upload = jest.fn().mockResolvedValue(STATUS);
  return { imageSource: { pick }, upload, maxBytes: 500_000, pick };
}

test('appareil photo avant, puis dépôt : le nouvel état revient', async () => {
  const d = deps({ uri: 'file:///moi.jpg', name: 'moi.jpg', mimeType: 'image/jpeg', sizeBytes: 100_000 });
  await expect(takeSelfie(d)).resolves.toEqual({ kind: 'sent', status: STATUS });
  expect(d.pick).toHaveBeenCalledWith({ source: 'camera', cameraFacing: 'front', maxBytes: 500_000 });
  expect(d.upload).toHaveBeenCalledWith({ uri: 'file:///moi.jpg', name: 'moi.jpg', mimeType: 'image/jpeg' });
});

test('annulé : rien n’est envoyé', async () => {
  const d = deps(null);
  await expect(takeSelfie(d)).resolves.toEqual({ kind: 'cancelled' });
  expect(d.upload).not.toHaveBeenCalled();
});

test('trop lourd : rien n’est envoyé', async () => {
  const d = deps({ uri: 'file:///moi.jpg', name: 'moi.jpg', mimeType: 'image/jpeg', sizeBytes: 900_000 });
  await expect(takeSelfie(d)).resolves.toEqual({ kind: 'too-heavy' });
  expect(d.upload).not.toHaveBeenCalled();
});
