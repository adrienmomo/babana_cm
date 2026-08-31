import { createDriverDocumentUploader, type DriverDocumentUploader } from '@babana/api-client';
import type { http } from '@babana/contracts';
import { API_BASE_URL } from '../config';
import { apiClient, authClient } from './auth';

/**
 * Câblage de l'inscription chauffeur (L6-15), à part des écrans -- même discipline que `auth.ts`
 * (un seul endroit construit les clients). Le téléversement multipart passe par
 * `createDriverDocumentUploader` (`@babana/api-client`) ; la lecture de l'état des documents
 * passe par le client REST générique déjà enrobé de renouvellement transparent (`apiClient`).
 */

export const documentUploader: DriverDocumentUploader = createDriverDocumentUploader({
  baseUrl: API_BASE_URL,
  getAccessToken: () => authClient.getAccessToken(),
  refreshAccessToken: async () => {
    try {
      await authClient.refresh();
    } catch (error) {
      // Même politique que `withTransparentRefresh` : un renouvellement raté déconnecte
      // proprement, et l'erreur d'origine remonte à l'appelant.
      await authClient.handleRefreshFailure();
      throw error;
    }
  },
});

export async function fetchDriverDocuments(): Promise<http.DriverDocument[]> {
  const response = (await apiClient.request('listDriverDocuments')) as http.ListDriverDocumentsResponse;
  return response.documents;
}
