import {
  createPushRegistrar,
  createUnavailablePushBinding,
  type PushApiClient,
  type PushBinding,
} from '../../src/push';

function fakeApiClient() {
  const calls: Array<{ name: string; body: unknown }> = [];
  const client: PushApiClient & { calls: typeof calls; fail: boolean } = {
    calls,
    fail: false,
    request: jest.fn(async (name: string, options: { body: unknown }) => {
      calls.push({ name, body: options.body });
      if (client.fail) throw new Error('réseau');
      return name === 'registerDeviceToken' ? { registered: true } : { deactivated: true };
    }),
  };
  return client;
}

function fakeBinding(overrides: Partial<PushBinding> = {}) {
  let rotationListener: ((token: string) => void) | null = null;
  const binding: PushBinding & { rotate: (t: string) => void; hasRotationListener: () => boolean } = {
    requestPermission: jest.fn(async () => true),
    getToken: jest.fn(async () => 'tok-1'),
    onTokenRefresh: jest.fn((listener: (token: string) => void) => {
      rotationListener = listener;
      return () => {
        rotationListener = null;
      };
    }),
    rotate: (t: string) => rotationListener?.(t),
    hasRotationListener: () => rotationListener !== null,
    ...overrides,
  };
  return binding;
}

describe('createPushRegistrar (L7-01 -- enregistrement à la connexion et à chaque rotation)', () => {
  it('enregistre le jeton courant avec la plateforme, et s’abonne aux rotations', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });

    const outcome = await registrar.register();

    expect(outcome).toEqual({ registered: true, token: 'tok-1' });
    expect(apiClient.calls).toEqual([
      { name: 'registerDeviceToken', body: { token: 'tok-1', platform: 'android' } },
    ]);
    expect(binding.hasRotationListener()).toBe(true);
    registrar.dispose();
  });

  it('une rotation du jeton re-poste le nouveau jeton', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'ios' });
    await registrar.register();

    binding.rotate('tok-2');
    await Promise.resolve();
    await Promise.resolve();

    expect(apiClient.calls).toEqual([
      { name: 'registerDeviceToken', body: { token: 'tok-1', platform: 'ios' } },
      { name: 'registerDeviceToken', body: { token: 'tok-2', platform: 'ios' } },
    ]);
    registrar.dispose();
  });

  it('permission refusée : aucune écriture, aucun jeton, pas d’exception (L7-06)', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding({ requestPermission: jest.fn(async () => false) });
    const notices: unknown[] = [];
    const registrar = createPushRegistrar({
      apiClient,
      binding,
      platform: 'android',
      onNotice: (o) => notices.push(o),
    });

    const outcome = await registrar.register();

    expect(outcome).toEqual({ registered: false, reason: 'permission-denied' });
    expect(apiClient.calls).toEqual([]);
    expect(binding.hasRotationListener()).toBe(false);
    expect(notices).toEqual([{ registered: false, reason: 'permission-denied' }]);
  });

  it('aucun jeton disponible : issue explicite, pas d’enregistrement', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding({ getToken: jest.fn(async () => null) });
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });

    expect(await registrar.register()).toEqual({ registered: false, reason: 'no-token' });
    expect(apiClient.calls).toEqual([]);
  });

  it('binding indisponible (aucun SDK branché) : issue "unavailable", jamais une exception, jamais un jeton inventé', async () => {
    const apiClient = fakeApiClient();
    const registrar = createPushRegistrar({
      apiClient,
      binding: createUnavailablePushBinding(),
      platform: 'android',
    });

    const outcome = await registrar.register();

    expect(outcome.registered).toBe(false);
    expect(outcome).toMatchObject({ reason: 'unavailable' });
    expect(apiClient.calls).toEqual([]);
  });

  it('échec de l’écriture serveur : issue "error", non bloquante', async () => {
    const apiClient = fakeApiClient();
    apiClient.fail = true;
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });

    const outcome = await registrar.register();

    expect(outcome).toMatchObject({ registered: false, reason: 'error' });
  });

  it('unregister désactive le jeton courant et coupe l’écoute des rotations', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });
    await registrar.register();

    await registrar.unregister();

    expect(apiClient.calls).toEqual([
      { name: 'registerDeviceToken', body: { token: 'tok-1', platform: 'android' } },
      { name: 'deactivateDeviceToken', body: { token: 'tok-1' } },
    ]);
    expect(binding.hasRotationListener()).toBe(false);
  });

  it('unregister est best-effort : un échec réseau ne rejette pas', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });
    await registrar.register();
    apiClient.fail = true;

    await expect(registrar.unregister()).resolves.toBeUndefined();
  });

  it('deux register() successifs ne laissent qu’un seul abonnement aux rotations', async () => {
    const apiClient = fakeApiClient();
    const binding = fakeBinding();
    const registrar = createPushRegistrar({ apiClient, binding, platform: 'android' });

    await registrar.register();
    await registrar.register();

    expect(binding.onTokenRefresh).toHaveBeenCalledTimes(2);
    // Le premier abonnement a été résilié avant le second : une seule rotation -> un seul re-post.
    binding.rotate('tok-9');
    await Promise.resolve();
    await Promise.resolve();
    const rotationPosts = apiClient.calls.filter(
      (c) => c.name === 'registerDeviceToken' && (c.body as { token: string }).token === 'tok-9'
    );
    expect(rotationPosts).toHaveLength(1);
    registrar.dispose();
  });
});
