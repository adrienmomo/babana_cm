import { http } from '@babana/contracts';
import { ApiError } from '../http/errors';

/**
 * Téléversement d'un document chauffeur (L6-15, L1-05). À part du client REST générique
 * (`../http/client.ts`) pour une seule raison : `POST /driver/documents` attend un corps
 * `multipart/form-data` (fichier + champs), là où `createHttpClient` sérialise toujours en JSON
 * avec `Content-Type: application/json`. Tout le reste -- en-tête `Authorization`, lecture du
 * catalogue d'erreurs C-01, renouvellement transparent du jeton -- suit les mêmes règles.
 *
 * La LECTURE de l'état des documents (`GET /driver/documents`, L6-15 critères 3 et 5) n'a pas
 * besoin de ce module : c'est un GET sans corps, `apiClient.request('listDriverDocuments')`
 * suffit.
 */

export interface DriverDocumentFile {
  /** URI locale du fichier, déjà **compressé** par l'appelant (L6-15 critère 2 -- une photo de
   * dix mégaoctets ne partira jamais sur un réseau mobile camerounais). */
  uri: string;
  /** Nom de fichier porté par le champ multipart. */
  name: string;
  /** Type MIME du fichier compressé. Le serveur revérifie le type réel par signature (L1-05
   * critère 4) ; ce champ est ce que le formulaire déclare, il doit lui être cohérent. */
  mimeType: string;
}

export interface UploadDriverDocumentInput {
  documentType: http.DriverDocumentType;
  file: DriverDocumentFile;
  /** Obligatoire pour un permis (L1-05 critère 5). Format `YYYY-MM-DD`. */
  expiresOn?: string;
}

export interface DriverDocumentUploaderConfig {
  /** Racine du domaine, ex. `https://api.babana.cm` -- jamais codée en dur (invariant 5). */
  baseUrl: string;
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Renouvellement transparent (même politique que `withTransparentRefresh` pour le client
   * REST, L6-02 critères 2 et 3) : appelé une seule fois si le premier essai échoue en
   * `TOKEN_EXPIRED`, suivi d'un unique réessai. Absent, un jeton expiré remonte tel quel.
   */
  refreshAccessToken?: () => Promise<unknown>;
  /** Injectable pour les tests -- `fetch` global par défaut. */
  fetchImpl?: typeof fetch;
  /** Injectable pour les tests -- `FormData` global par défaut (React Native en fournit un). */
  formDataImpl?: { new (): FormData };
}

export interface DriverDocumentUploader {
  upload(input: UploadDriverDocumentInput): Promise<http.UploadDriverDocumentResponse>;
}

const ENDPOINT = http.HTTP_ENDPOINTS.uploadDriverDocument;

export function createDriverDocumentUploader(config: DriverDocumentUploaderConfig): DriverDocumentUploader {
  const fetchImpl = config.fetchImpl ?? fetch;
  const FormDataImpl = config.formDataImpl ?? FormData;
  const url = `${config.baseUrl.replace(/\/$/, '')}${ENDPOINT.path}`;

  async function attempt(input: UploadDriverDocumentInput): Promise<http.UploadDriverDocumentResponse> {
    const form = new FormDataImpl();
    form.append('documentType', input.documentType);
    form.append('contentType', input.file.mimeType);
    if (input.expiresOn) form.append('expiresOn', input.expiresOn);
    // React Native attend `{ uri, name, type }` pour un fichier local dans un FormData -- ce
    // n'est pas un Blob, et les types DOM ne décrivent pas cette forme : cast délibéré, isolé
    // à cette ligne.
    form.append('file', { uri: input.file.uri, name: input.file.name, type: input.file.mimeType } as unknown as Blob);

    const token = await config.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    // Pas de `Content-Type` explicite : `fetch` le pose lui-même, avec la frontière multipart.

    const response = await fetchImpl(url, { method: 'POST', headers, body: form as unknown as RequestInit['body'] });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const parsed = http.ApiErrorSchema.safeParse(payload);
      throw parsed.success
        ? new ApiError(parsed.data.error.code, parsed.data.error.message, response.status, parsed.data.error.details)
        : new ApiError('INTERNAL_ERROR', `Réponse d'erreur non reconnue (HTTP ${response.status})`, response.status, payload);
    }

    return ENDPOINT.responseSchema.parse(payload) as http.UploadDriverDocumentResponse;
  }

  return {
    async upload(input) {
      try {
        return await attempt(input);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'TOKEN_EXPIRED' && config.refreshAccessToken) {
          await config.refreshAccessToken();
          return attempt(input);
        }
        throw error;
      }
    },
  };
}
