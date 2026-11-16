import type { http } from '@babana/contracts';
import { ONBOARDING_MAX_DOCUMENT_BYTES } from '../config';
import { selfieUploader } from './onboarding';
import { defaultImageSource, type ImageSource } from './screens/onboarding/imageSource';

/**
 * Selfie de contrôle (15 novembre) : une photo de soi, appareil photo avant -- jamais la galerie,
 * un selfie ancien ne prouverait rien. Déposé, il compte tout de suite (le chauffeur travaille
 * pendant la revue au back-office) ; le serveur répond le nouvel état.
 */
export interface SelfieDeps {
  imageSource: ImageSource;
  upload(file: { uri: string; name: string; mimeType: string }): Promise<http.DriverSelfieStatus>;
  maxBytes: number;
}

const defaultDeps: SelfieDeps = {
  imageSource: defaultImageSource,
  upload: (file) => selfieUploader.upload(file),
  maxBytes: ONBOARDING_MAX_DOCUMENT_BYTES,
};

export type SelfieOutcome = { kind: 'sent'; status: http.DriverSelfieStatus } | { kind: 'cancelled' } | { kind: 'too-heavy' };

export async function takeSelfie(deps: SelfieDeps = defaultDeps): Promise<SelfieOutcome> {
  const picked = await deps.imageSource.pick({ source: 'camera', cameraFacing: 'front', maxBytes: deps.maxBytes });
  if (!picked) return { kind: 'cancelled' };
  if (picked.sizeBytes > deps.maxBytes) return { kind: 'too-heavy' };
  const status = await deps.upload({ uri: picked.uri, name: picked.name, mimeType: picked.mimeType });
  return { kind: 'sent', status };
}
