import { createJsonRpcClient, JsonRpcError } from '../../src/http/rpc';

function jsonResponse(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as unknown as Response;
}

describe('createJsonRpcClient (L6-03, JSON-RPC pour les lectures secondaires)', () => {
  it("enveloppe l'appel en JSON-RPC 2.0 et porte le jeton en Bearer", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ result: [{ id: 1 }] }));
    const client = createJsonRpcClient({
      url: 'https://api.test/jsonrpc',
      fetchImpl,
      getAccessToken: () => 'token-1',
    });

    const result = await client.call({ model: 'babana.ride', method: 'search_read', args: [[]] });

    expect(result).toEqual([{ id: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/jsonrpc');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-1');
    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('call');
    expect(body.params).toEqual({ model: 'babana.ride', method: 'search_read', args: [[]], kwargs: {} });
  });

  it('une erreur JSON-RPC devient une JsonRpcError, pas un résultat silencieusement vide', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: { message: 'Access Denied', data: { name: 'AccessError' } } }));
    const client = createJsonRpcClient({ url: 'https://api.test/jsonrpc', fetchImpl });

    await expect(client.call({ model: 'babana.ride', method: 'read' })).rejects.toBeInstanceOf(JsonRpcError);
  });
});
