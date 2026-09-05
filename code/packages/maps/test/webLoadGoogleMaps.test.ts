/**
 * loadGoogleMaps (fournisseur web, L6-18) -- testé sans jsdom, même discipline qu'
 * `@babana/api-client`'s `googleSignIn.web.test.ts` : un double minimal de `document`/`window`
 * suffit à exercer le chargement du script, sans SDK réel (critère d'acceptation 4, L6-01).
 */
import { _resetGoogleMapsLoaderForTests, loadGoogleMaps } from '../src/providers/web/loadGoogleMaps';

interface FakeScript {
  src?: string;
  onload?: () => void;
  onerror?: () => void;
}

function installFakeDom(): { headAppended: FakeScript[] } {
  const headAppended: FakeScript[] = [];
  (global as unknown as { document: unknown }).document = {
    createElement: (): FakeScript => {
      const script: FakeScript = {};
      return script;
    },
    head: {
      appendChild: (el: FakeScript) => headAppended.push(el),
    },
  };
  (global as unknown as { window: unknown }).window = global;
  return { headAppended };
}

function uninstallFakeDom(): void {
  delete (global as unknown as { document?: unknown }).document;
  delete (global as unknown as { window?: unknown }).window;
  delete (global as unknown as { google?: unknown }).google;
}

describe('loadGoogleMaps (fournisseur web, L6-18)', () => {
  afterEach(() => {
    _resetGoogleMapsLoaderForTests();
    uninstallFakeDom();
  });

  it("échoue clairement hors d'un navigateur (pas de document)", async () => {
    await expect(loadGoogleMaps('')).rejects.toThrow(/navigateur/);
  });

  it('résout dès que window.google.maps existe déjà -- aucun script ajouté', async () => {
    const { headAppended } = installFakeDom();
    (global as unknown as { google: unknown }).google = { maps: {} };

    await expect(loadGoogleMaps('')).resolves.toBeUndefined();
    expect(headAppended).toHaveLength(0);
  });

  it('ajoute un script portant la clé configurée, et résout quand son callback global est invoqué', async () => {
    const { headAppended } = installFakeDom();

    const pending = loadGoogleMaps('test-maps-key');
    await Promise.resolve();

    expect(headAppended).toHaveLength(1);
    const script = headAppended[0];
    expect(script?.src).toContain('key=test-maps-key');
    expect(script?.src).toContain('callback=__babanaGoogleMapsReady');

    // Simule ce que ferait réellement le script chargé : appeler le callback nommé qu'il trouve
    // sur `window`, exactement comme le fait le paramètre `callback=` de l'API Google.
    (global as unknown as Record<string, () => void>).__babanaGoogleMapsReady?.();

    await expect(pending).resolves.toBeUndefined();
  });

  it('omet le paramètre "key" quand la clé est vide (développement, D19)', async () => {
    const { headAppended } = installFakeDom();

    loadGoogleMaps('').catch(() => {});
    await Promise.resolve();

    expect(headAppended[0]?.src).not.toContain('key=');
  });

  it('ne charge le script qu\'une seule fois pour deux appels concurrents', async () => {
    const { headAppended } = installFakeDom();

    loadGoogleMaps('test-maps-key').catch(() => {});
    loadGoogleMaps('test-maps-key').catch(() => {});
    await Promise.resolve();

    expect(headAppended).toHaveLength(1);
  });

  it('permet un nouvel essai si le script échoue à charger', async () => {
    const { headAppended } = installFakeDom();

    const firstAttempt = loadGoogleMaps('test-maps-key');
    await Promise.resolve();
    headAppended[0]?.onerror?.();

    await expect(firstAttempt).rejects.toThrow(/échoué/);

    const secondAttempt = loadGoogleMaps('test-maps-key');
    await Promise.resolve();
    expect(headAppended).toHaveLength(2);
    (global as unknown as Record<string, () => void>).__babanaGoogleMapsReady?.();
    await expect(secondAttempt).resolves.toBeUndefined();
  });
});
