import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * Documents chauffeur (permis, pièce d'identité), L1-05. Fichier non listé explicitement dans
 * l'arborescence de la spécification C-01 (implémentation, voir le message de commit) --
 * même situation que phone.ts et driver.ts.
 *
 * POST /driver/documents n'a pas de corps JSON : c'est un téléversement multipart/form-data
 * (fichier + champs). UploadDriverDocumentFieldsSchema décrit les champs autres que le fichier
 * -- utile côté app pour construire le formulaire -- mais n'est pas enregistré comme
 * requestSchema de l'endpoint (voir index.ts) : generate-json-schema.ts et le catalogue
 * supposent tous deux un corps JSON pur pour ce champ-là.
 */

export const DriverDocumentTypeSchema = z.enum(['license', 'id_card']);
export type DriverDocumentType = z.infer<typeof DriverDocumentTypeSchema>;

export const DriverDocumentVerificationStatusSchema = z.enum(['pending', 'verified', 'rejected']);
export type DriverDocumentVerificationStatus = z.infer<typeof DriverDocumentVerificationStatusSchema>;

/**
 * Champs multipart de POST /driver/documents, en plus du fichier lui-même (champ `file`).
 * `expiresOn` est obligatoire quand `documentType` vaut 'license' (critère d'acceptation 5 de
 * L1-05) -- pas encodé ici en contrainte croisée Zod pour rester une description simple des
 * champs de formulaire ; le serveur est la source de vérité de cette règle.
 */
export const UploadDriverDocumentFieldsSchema = z.object({
  documentType: DriverDocumentTypeSchema,
  contentType: z.string().min(1).describe('type MIME déclaré par le client ; le serveur vérifie le type réel (critère 4)'),
  expiresOn: z.string().date().optional(),
});
export type UploadDriverDocumentFields = z.infer<typeof UploadDriverDocumentFieldsSchema>;

export const UploadDriverDocumentResponseSchema = z.object({
  id: z.number().int().positive(),
  documentType: DriverDocumentTypeSchema,
  verificationStatus: DriverDocumentVerificationStatusSchema,
});
export type UploadDriverDocumentResponse = z.infer<typeof UploadDriverDocumentResponseSchema>;

export const UploadDriverDocumentErrors = ['DOCUMENT_TYPE_MISMATCH'] as const;

export const uploadDriverDocumentFieldsExample: UploadDriverDocumentFields = {
  documentType: 'id_card',
  contentType: 'image/jpeg',
};

export const uploadDriverDocumentResponseExample: UploadDriverDocumentResponse = {
  id: 42,
  documentType: 'id_card',
  verificationStatus: 'pending',
};

/**
 * GET /driver/documents/{id}/url
 * URL signée à durée limitée (critères 1 et 2 de L1-05) -- jamais la clé de stockage elle-même.
 */
export const DriverDocumentSignedUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresIn: z.number().int().positive().describe('secondes avant expiration de l\'URL signée'),
});
export type DriverDocumentSignedUrlResponse = z.infer<typeof DriverDocumentSignedUrlResponseSchema>;

export const DriverDocumentSignedUrlErrors = ['DOCUMENT_NOT_FOUND', 'DOCUMENT_NOT_OWNED'] as const;

export const driverDocumentSignedUrlResponseExample: DriverDocumentSignedUrlResponse = {
  url: 'https://storage.babana.cm/babana-documents/drivers/42/id_card/....jpg?X-Amz-Signature=...',
  expiresIn: 300,
};

/**
 * GET /driver/documents
 * Documents du chauffeur courant avec leur état de vérification (L6-15) : c'est ce que lit
 * l'écran d'attente de dossier pour dire précisément où il en est -- « il manque votre permis »
 * (aucune ligne `license`), « permis rejeté : <motif> » (`verificationStatus: 'rejected'` +
 * `rejectionReason`), « en cours de validation » (`pending`). Jamais la clé de stockage :
 * l'aperçu passe toujours par `GET /driver/documents/{id}/url`.
 *
 * Ajouté au contrat en implémentant L6-15 (les critères 3 et 5 l'exigent, le contrat n'avait
 * qu'un endpoint d'écriture et un endpoint d'URL signée) -- extension additive, même précédent
 * que L2-04 et L3-04. Endpoint jamais listé dans l'arborescence de C-01, comme le reste de ce
 * fichier.
 */
export const DriverDocumentSchema = z.object({
  id: z.number().int().positive(),
  documentType: DriverDocumentTypeSchema,
  verificationStatus: DriverDocumentVerificationStatusSchema,
  /** Renseigné seulement quand `verificationStatus` vaut `'rejected'` -- le motif transmis au
   * chauffeur (L6-15 critère 3, L7-03). `null` sinon : jamais un champ absent qui masquerait
   * silencieusement l'information (même règle que D30). */
  rejectionReason: z.string().nullable(),
  /** Date d'expiration -- obligatoire pour un permis (L1-05 critère 5), `null` pour une pièce
   * d'identité. */
  expiresOn: z.string().date().nullable(),
  uploadedAt: IsoDateTimeSchema,
});
export type DriverDocument = z.infer<typeof DriverDocumentSchema>;

export const ListDriverDocumentsResponseSchema = z.object({
  documents: z.array(DriverDocumentSchema),
});
export type ListDriverDocumentsResponse = z.infer<typeof ListDriverDocumentsResponseSchema>;

// Rien au-delà des erreurs implicites (UNAUTHORIZED) : une lecture de ses propres documents ne
// refuse jamais un chauffeur non approuvé -- c'est précisément l'écran qu'il consulte en
// attendant l'approbation (même raison que /me, L1-01 critère 8).
export const ListDriverDocumentsErrors = [] as const;

export const listDriverDocumentsResponseExample: ListDriverDocumentsResponse = {
  documents: [
    {
      id: 42,
      documentType: 'license',
      verificationStatus: 'rejected',
      rejectionReason: 'Photo floue — le numéro de permis est illisible.',
      expiresOn: '2030-01-01',
      uploadedAt: '2026-08-30T09:12:00Z',
    },
    {
      id: 43,
      documentType: 'id_card',
      verificationStatus: 'pending',
      rejectionReason: null,
      expiresOn: null,
      uploadedAt: '2026-08-30T09:14:00Z',
    },
  ],
};
