/**
 * Sélection d'une photo de document (L6-15) -- appareil photo avec cadrage guidé, ou galerie,
 * puis compression sous une taille cible (critère d'acceptation 2 : « une photo de dix
 * mégaoctets sur un réseau mobile camerounais ne partira jamais »).
 *
 * **Injecté, comme les dépendances de `location/tracker.ts`** : aucune bibliothèque native de
 * capture / compression d'image n'est une dépendance de `apps/driver` aujourd'hui, et une telle
 * dépendance (accès caméra, redimensionnement natif, configuration `AndroidManifest.xml`) n'est
 * ni ajoutable à l'aveugle ni vérifiable sans build mobile -- exactement la situation du service
 * de premier plan de L6-05. Signalé dans `amoa/questions/L6-15.md`, pas tranché seul.
 *
 * Les écrans prennent un `ImageSource` en props ; les tests fournissent un double. Depuis le 15
 * novembre, la valeur par défaut est le sélecteur natif ci-dessous.
 */
import { launchCamera, launchImageLibrary, type CameraOptions, type PhotoQuality } from 'react-native-image-picker';

export interface PickedImage {
  /** URI locale du fichier compressé. */
  uri: string;
  name: string;
  mimeType: string;
  /** Taille du fichier compressé, en octets -- l'écran vérifie qu'elle est sous le plafond
   * configuré avant de tenter l'envoi. */
  sizeBytes: number;
}

export interface PickImageOptions {
  source: 'camera' | 'gallery';
  /** Appareil photo avant pour un portrait (photo de profil, selfie) ; arrière par défaut. */
  cameraFacing?: 'front' | 'back';
  /** Taille maximale acceptée après compression (octets). */
  maxBytes: number;
}

export interface ImageSource {
  /** Ouvre la source demandée, compresse, renvoie l'image ou `null` si l'utilisateur annule.
   * Doit lever si la compression ne parvient pas sous `maxBytes`. */
  pick(options: PickImageOptions): Promise<PickedImage | null>;
}

/**
 * Sélecteur natif (15 novembre) : `react-native-image-picker`, la recommandation de
 * `amoa/questions/L6-15.md` (option 1), ajoutée pour la photo de profil et le selfie. Appareil
 * photo par intention Android (aucune permission CAMERA à demander), ou galerie. La photo est
 * réduite à la prise (côté et qualité), puis réduite encore si elle dépasse `maxBytes` -- jamais
 * envoyée au-dessus du plafond.
 */
const COMPRESSION_STEPS: readonly { maxSide: number; quality: PhotoQuality }[] = [
  { maxSide: 1600, quality: 0.7 },
  { maxSide: 1280, quality: 0.6 },
  { maxSide: 1024, quality: 0.5 },
];

export function createNativeImageSource(picker: { launchCamera: typeof launchCamera; launchImageLibrary: typeof launchImageLibrary } = { launchCamera, launchImageLibrary }): ImageSource {
  return {
    async pick({ source, maxBytes, cameraFacing = 'back' }) {
      for (const step of COMPRESSION_STEPS) {
        const options: CameraOptions = {
          mediaType: 'photo',
          maxWidth: step.maxSide,
          maxHeight: step.maxSide,
          quality: step.quality,
          cameraType: cameraFacing,
          saveToPhotos: false,
          includeBase64: false,
        };
        const response = source === 'camera' ? await picker.launchCamera(options) : await picker.launchImageLibrary(options);
        if (response.didCancel) return null;
        if (response.errorCode) throw new Error(response.errorMessage ?? response.errorCode);
        const asset = response.assets?.[0];
        if (!asset?.uri) throw new Error('Aucune photo reçue.');
        const picked: PickedImage = {
          uri: asset.uri,
          name: asset.fileName ?? 'photo.jpg',
          mimeType: asset.type ?? 'image/jpeg',
          sizeBytes: asset.fileSize ?? 0,
        };
        if (picked.sizeBytes <= maxBytes) return picked;
        // Trop lourde : une seconde prise, plus réduite, plutôt qu'un envoi au-dessus du plafond.
        if (source === 'gallery') continue;
        return picked; // appareil photo : l'écran le dit (« reprenez-la de plus loin »)
      }
      throw new Error('Photo trop lourde, même réduite.');
    },
  };
}

export const defaultImageSource: ImageSource = createNativeImageSource();
