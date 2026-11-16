import { createNativeImageSource } from '../imageSource';

// 15 novembre : le sélecteur natif (react-native-image-picker), branché pour la photo de profil et
// le selfie -- `amoa/questions/L6-15.md`, option 1.

const MAX = 500_000;

function picker(responses: unknown[]) {
  const launchCamera = jest.fn();
  const launchImageLibrary = jest.fn();
  for (const response of responses) {
    launchCamera.mockResolvedValueOnce(response);
    launchImageLibrary.mockResolvedValueOnce(response);
  }
  return { launchCamera, launchImageLibrary };
}

const asset = (fileSize: number) => ({ assets: [{ uri: 'file:///photo.jpg', fileName: 'photo.jpg', type: 'image/jpeg', fileSize }] });

test('annulé : rien, sans erreur', async () => {
  const p = picker([{ didCancel: true }]);
  await expect(createNativeImageSource(p).pick({ source: 'camera', maxBytes: MAX })).resolves.toBeNull();
});

test('une erreur du sélecteur remonte (l’écran dit « la prise de photo a échoué »)', async () => {
  const p = picker([{ errorCode: 'camera_unavailable', errorMessage: 'pas de caméra' }]);
  await expect(createNativeImageSource(p).pick({ source: 'camera', maxBytes: MAX })).rejects.toThrow('pas de caméra');
});

test('portrait : appareil photo avant, photo réduite à la prise', async () => {
  const p = picker([asset(200_000)]);
  const picked = await createNativeImageSource(p).pick({ source: 'camera', maxBytes: MAX, cameraFacing: 'front' });
  expect(picked).toEqual({ uri: 'file:///photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 200_000 });
  expect(p.launchCamera).toHaveBeenCalledWith(expect.objectContaining({ cameraType: 'front', mediaType: 'photo', maxWidth: 1600, quality: 0.7 }));
});

test('galerie trop lourde : rouverte avec une réduction plus forte, jamais envoyée au-dessus du plafond', async () => {
  const p = picker([asset(900_000), asset(400_000)]);
  const picked = await createNativeImageSource(p).pick({ source: 'gallery', maxBytes: MAX });
  expect(picked!.sizeBytes).toBe(400_000);
  expect(p.launchImageLibrary).toHaveBeenLastCalledWith(expect.objectContaining({ maxWidth: 1280, quality: 0.6 }));
});

test('appareil photo trop lourd : rendu tel quel, l’écran demande de reprendre (pas de seconde prise imposée)', async () => {
  const p = picker([asset(900_000)]);
  const picked = await createNativeImageSource(p).pick({ source: 'camera', maxBytes: MAX });
  expect(picked!.sizeBytes).toBe(900_000);
  expect(p.launchCamera).toHaveBeenCalledTimes(1);
});
