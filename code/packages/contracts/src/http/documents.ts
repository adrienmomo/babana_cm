import { z } from 'zod';

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
