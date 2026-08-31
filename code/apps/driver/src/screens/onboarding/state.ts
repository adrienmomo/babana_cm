import AsyncStorage from '@react-native-async-storage/async-storage';
import type { http } from '@babana/contracts';

/**
 * Logique d'inscription chauffeur (L6-15), séparée des écrans -- fonctions pures pour la
 * dérivation de l'avancement, un petit magasin AsyncStorage pour ce qui doit survivre à une
 * fermeture de l'app.
 *
 * **Reprenable après fermeture** (critère d'acceptation 1) : l'avancement se DÉRIVE de l'état
 * serveur (`GET /driver/documents`, plus un drapeau local « profil confirmé »), jamais d'un
 * suivi local qui pourrait diverger. Rouvrir l'app relit le serveur et retombe sur le bon écran.
 *
 * **Le téléversement survit à une coupure** (spécification) : une photo prise puis compressée
 * est persistée localement (`PendingUpload`) avant l'envoi. Si le réseau tombe, le chauffeur
 * réessaie le MÊME fichier -- il ne reprend pas la photo.
 */

export type RequiredDocumentType = 'license' | 'id_card';
export const REQUIRED_DOCUMENT_TYPES: readonly RequiredDocumentType[] = ['license', 'id_card'];

export const DOCUMENT_LABELS: Record<RequiredDocumentType, string> = {
  license: 'Permis de conduire',
  id_card: "Pièce d'identité",
};

export type DocumentSlotStatus = 'missing' | 'pending' | 'verified' | 'rejected';

export interface DocumentSlot {
  type: RequiredDocumentType;
  status: DocumentSlotStatus;
  /** Renseigné seulement quand `status` vaut `'rejected'` (critère 3). */
  rejectionReason: string | null;
  expiresOn: string | null;
}

/** État de chaque document requis (critère 5) : le plus récent par type, complété d'un
 * `'missing'` explicite pour un type jamais téléversé. */
export function documentSlots(documents: readonly http.DriverDocument[]): DocumentSlot[] {
  const latestByType = new Map<string, http.DriverDocument>();
  for (const doc of documents) {
    if (!latestByType.has(doc.documentType)) latestByType.set(doc.documentType, doc);
  }
  return REQUIRED_DOCUMENT_TYPES.map((type) => {
    const doc = latestByType.get(type);
    if (!doc) {
      return { type, status: 'missing', rejectionReason: null, expiresOn: null };
    }
    const status: DocumentSlotStatus =
      doc.verificationStatus === 'verified'
        ? 'verified'
        : doc.verificationStatus === 'rejected'
          ? 'rejected'
          : 'pending';
    return {
      type,
      status,
      rejectionReason: status === 'rejected' ? doc.rejectionReason : null,
      expiresOn: doc.expiresOn,
    };
  });
}

export type OnboardingRoute = 'Profile' | 'Documents' | 'Pending' | 'Rejected';

/** Statut de dossier porté par la session (AuthenticatedUser.driverStatus). `undefined` quand le
 * rafraîchissement de session a échoué hors ligne -- traité en défaut-refus, comme `pending`. */
export type DriverStatus = 'pending' | 'approved' | 'rejected' | 'suspended' | undefined;

/**
 * Écran sur lequel reprendre l'inscription / le suivi de dossier (critère 1). Trois situations
 * qui n'appellent pas la même action (amoa/questions/REPONSES-2026-09-04.md §2) :
 *
 * - **refusé** (`driverStatus` 'rejected' ou 'suspended') -> `Rejected` : le motif, et le chemin
 *   pour corriger et resoumettre. Prime sur tout le reste -- un dossier refusé ne se raconte pas
 *   comme une inscription en cours.
 * - **incomplet** (un document manquant ou rejeté) -> `Documents` : il y a une pièce à
 *   (re)déposer, nommée.
 * - **en cours de validation** (tout est déposé) -> `Pending` : rien à faire qu'attendre.
 *
 * Et, avant tout cela, profil non confirmé -> `Profile`.
 */
export function resolveOnboardingRoute(
  slots: readonly DocumentSlot[],
  profileAcknowledged: boolean,
  driverStatus?: DriverStatus
): OnboardingRoute {
  if (driverStatus === 'rejected' || driverStatus === 'suspended') return 'Rejected';
  if (!profileAcknowledged) return 'Profile';
  if (slots.some((slot) => slot.status === 'missing' || slot.status === 'rejected')) return 'Documents';
  return 'Pending';
}

export function allDocumentsSubmitted(slots: readonly DocumentSlot[]): boolean {
  return slots.every((slot) => slot.status === 'pending' || slot.status === 'verified');
}

// --- Persistance locale -----------------------------------------------------------------------

export interface PendingUpload {
  type: RequiredDocumentType;
  uri: string;
  name: string;
  mimeType: string;
  /** Présent seulement pour un permis (critère 5 de L1-05). */
  expiresOn?: string;
}

const PREFIX = 'babana.driver.onboarding.';
const profileKey = (userId: string) => `${PREFIX}profileAck.${userId}`;
const pendingKey = (userId: string) => `${PREFIX}pendingUploads.${userId}`;

export async function loadProfileAcknowledged(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(profileKey(userId))) === '1';
  } catch {
    return false;
  }
}

export async function setProfileAcknowledged(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(profileKey(userId), '1');
  } catch {
    // Best effort -- le pire cas est de redemander la confirmation du profil au prochain
    // démarrage, jamais une perte de données.
  }
}

export async function loadPendingUploads(userId: string): Promise<Partial<Record<RequiredDocumentType, PendingUpload>>> {
  try {
    const raw = await AsyncStorage.getItem(pendingKey(userId));
    if (!raw) return {};
    return JSON.parse(raw) as Partial<Record<RequiredDocumentType, PendingUpload>>;
  } catch {
    return {};
  }
}

export async function savePendingUpload(userId: string, upload: PendingUpload): Promise<void> {
  const all = await loadPendingUploads(userId);
  all[upload.type] = upload;
  try {
    await AsyncStorage.setItem(pendingKey(userId), JSON.stringify(all));
  } catch {
    // idem : au pire, une photo à reprendre -- jamais un état incohérent.
  }
}

export async function clearPendingUpload(userId: string, type: RequiredDocumentType): Promise<void> {
  const all = await loadPendingUploads(userId);
  delete all[type];
  try {
    await AsyncStorage.setItem(pendingKey(userId), JSON.stringify(all));
  } catch {
    // idem.
  }
}
