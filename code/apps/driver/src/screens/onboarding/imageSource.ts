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
 * Les écrans prennent un `ImageSource` en props ; les tests fournissent un double. La valeur par
 * défaut échoue franchement (jamais une image inventée) tant qu'un sélecteur natif n'est pas
 * branché -- même principe que D43 : une absence explicite plutôt qu'un faux plausible.
 */

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
  /** Taille maximale acceptée après compression (octets). */
  maxBytes: number;
}

export interface ImageSource {
  /** Ouvre la source demandée, compresse, renvoie l'image ou `null` si l'utilisateur annule.
   * Doit lever si la compression ne parvient pas sous `maxBytes`. */
  pick(options: PickImageOptions): Promise<PickedImage | null>;
}

export const defaultImageSource: ImageSource = {
  async pick() {
    throw new Error(
      "Sélecteur de photo non branché : dépendance native de capture/compression à valider sur " +
        'un vrai terminal (voir amoa/questions/L6-15.md).'
    );
  },
};
