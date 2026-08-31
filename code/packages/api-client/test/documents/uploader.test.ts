import { createDriverDocumentUploader } from '../../src/documents';
import { ApiError } from '../../src/http/errors';

/** `FormData` minimal -- Node en fournit un global, mais on veut inspecter ce qui a été
 * appended sans dépendre de son itérateur exact. */
class FakeFormData {
  readonly entries: Array<[string, unknown]> = [];
  append(name: string, value: unknown): void {
    this.entries.push([name, value]);
  }
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 201, json: () => Promise.resolve(body) } as unknown as Response;
}
function errorResponse(status: number, code: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message: 'x', details: null } }),
  } as unknown as Response;
}

const LICENSE = {
  documentType: 'license' as const,
  file: { uri: 'file:///tmp/permis.jpg', name: 'permis.jpg', mimeType: 'image/jpeg' },
  expiresOn: '2030-01-01',
};

describe('createDriverDocumentUploader (L6-15)', () => {
  it('poste un multipart avec le fichier, le type déclaré et la date d’expiration', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse({ id: 7, documentType: 'license', verificationStatus: 'pending' })
    );
    const uploader = createDriverDocumentUploader({
      baseUrl: 'https://api.test/',
      getAccessToken: () => 'tok',
      fetchImpl,
      formDataImpl: FakeFormData as unknown as { new (): FormData },
    });

    const result = await uploader.upload(LICENSE);

    expect(result).toEqual({ id: 7, documentType: 'license', verificationStatus: 'pending' });
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://api.test/api/v1/driver/documents');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    // fetch pose lui-même le Content-Type multipart -- on ne doit pas l'avoir forcé.
    expect(init.headers['Content-Type']).toBeUndefined();
    const form = init.body as unknown as FakeFormData;
    expect(form.entries).toEqual([
      ['documentType', 'license'],
      ['contentType', 'image/jpeg'],
      ['expiresOn', '2030-01-01'],
      ['file', { uri: 'file:///tmp/permis.jpg', name: 'permis.jpg', type: 'image/jpeg' }],
    ]);
  });

  it('n’ajoute pas expiresOn pour une pièce d’identité', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse({ id: 8, documentType: 'id_card', verificationStatus: 'pending' })
    );
    const uploader = createDriverDocumentUploader({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      fetchImpl,
      formDataImpl: FakeFormData as unknown as { new (): FormData },
    });

    await uploader.upload({
      documentType: 'id_card',
      file: { uri: 'file:///tmp/cni.png', name: 'cni.png', mimeType: 'image/png' },
    });

    const form = fetchImpl.mock.calls[0][1].body as unknown as FakeFormData;
    expect(form.entries.map(([k]) => k)).toEqual(['documentType', 'contentType', 'file']);
  });

  it('traduit une erreur métier en ApiError sans réessayer', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(400, 'DOCUMENT_TYPE_MISMATCH'));
    const uploader = createDriverDocumentUploader({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      fetchImpl,
      formDataImpl: FakeFormData as unknown as { new (): FormData },
    });

    await expect(uploader.upload(LICENSE)).rejects.toMatchObject({
      constructor: ApiError,
      code: 'DOCUMENT_TYPE_MISMATCH',
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('renouvelle le jeton une fois puis rejoue sur TOKEN_EXPIRED', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(errorResponse(401, 'TOKEN_EXPIRED'))
      .mockResolvedValueOnce(okResponse({ id: 9, documentType: 'license', verificationStatus: 'pending' }));
    const refreshAccessToken = jest.fn().mockResolvedValue(undefined);
    const uploader = createDriverDocumentUploader({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      refreshAccessToken,
      fetchImpl,
      formDataImpl: FakeFormData as unknown as { new (): FormData },
    });

    const result = await uploader.upload(LICENSE);

    expect(result.id).toBe(9);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sans refreshAccessToken, TOKEN_EXPIRED remonte tel quel', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(401, 'TOKEN_EXPIRED'));
    const uploader = createDriverDocumentUploader({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      fetchImpl,
      formDataImpl: FakeFormData as unknown as { new (): FormData },
    });

    await expect(uploader.upload(LICENSE)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
