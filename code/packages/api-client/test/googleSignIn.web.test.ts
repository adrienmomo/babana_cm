/**
 * signInWithGoogleNative (fournisseur web, L6-18, D22) -- testé sans jsdom : le préréglage jest
 * de ce paquet (`@react-native/jest-preset`) tourne en environnement `node`, sans `document` ni
 * `window` réels. Un double minimal de chacun (juste la surface que `googleSignIn.web.ts`
 * consomme -- createElement, un style objet, appendChild/remove, et `window.google.accounts.id`)
 * suffit à exercer la vraie logique du fichier, sans tirer une dépendance jsdom pour un seul
 * fichier (même discipline que le reste du paquet : aucun SDK réel, critère d'acceptation 4).
 *
 * `window.google` n'est posé qu'au moment où le double du script GIS "charge" (son `onload`),
 * jamais avant `signInWithGoogleNative()` -- le poser plus tôt ferait passer à tort le test de
 * `loadGsiScript()` par la branche "déjà chargé", sans jamais exercer la création du `<script>`.
 */
import {
  GoogleSignInCancelledError,
  _resetGoogleSignInConfigForTests,
  configureGoogleSignIn,
  signInWithGoogleNative,
} from '../src/auth/googleSignIn.web';

interface FakeElement {
  tagName: string;
  style: Record<string, string>;
  children: FakeElement[];
  onload?: () => void;
  onerror?: () => void;
  onclick?: () => void;
  removed: boolean;
  appendChild(child: FakeElement): void;
  remove(): void;
}

function createFakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    style: {},
    children: [],
    removed: false,
    appendChild(child) {
      element.children.push(child);
    },
    remove() {
      element.removed = true;
    },
  };
  return element;
}

interface FakeGoogleId {
  initialize: jest.Mock;
  renderButton: jest.Mock;
}

function installFakeDom(): {
  headAppended: FakeElement[];
  bodyAppended: FakeElement[];
  /** Simule la fin de chargement du script GIS : pose `window.google` puis déclenche `onload`. */
  finishScriptLoad: (google: FakeGoogleId) => void;
} {
  const headAppended: FakeElement[] = [];
  const bodyAppended: FakeElement[] = [];

  (global as unknown as { document: unknown }).document = {
    createElement: (tag: string) => createFakeElement(tag),
    head: { appendChild: (el: FakeElement) => headAppended.push(el) },
    body: { appendChild: (el: FakeElement) => bodyAppended.push(el) },
  };
  (global as unknown as { window: unknown }).window = global;

  return {
    headAppended,
    bodyAppended,
    finishScriptLoad(google) {
      (global as unknown as { google: unknown }).google = { accounts: { id: google } };
      headAppended[headAppended.length - 1]?.onload?.();
    },
  };
}

function uninstallFakeDom(): void {
  delete (global as unknown as { document?: unknown }).document;
  delete (global as unknown as { window?: unknown }).window;
  delete (global as unknown as { google?: unknown }).google;
}

function fakeGoogleId(): FakeGoogleId & { capturedCallback?: (response: { credential?: string }) => void } {
  const fake: FakeGoogleId & { capturedCallback?: (response: { credential?: string }) => void } = {
    initialize: jest.fn((config: { callback: (response: { credential?: string }) => void }) => {
      fake.capturedCallback = config.callback;
    }),
    renderButton: jest.fn(),
  };
  return fake;
}

describe('signInWithGoogleNative (L6-18, fournisseur web -- Google Identity Services)', () => {
  afterEach(() => {
    _resetGoogleSignInConfigForTests();
    uninstallFakeDom();
  });

  it('exige configureGoogleSignIn avant tout appel', async () => {
    await expect(signInWithGoogleNative()).rejects.toThrow(/configureGoogleSignIn/);
  });

  it("échoue clairement hors d'un navigateur (pas de document)", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });

    await expect(signInWithGoogleNative()).rejects.toThrow(/navigateur/);
  });

  it("charge le script GIS, initialise avec l'identifiant configuré, et résout avec le credential reçu", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });
    const { headAppended, bodyAppended, finishScriptLoad } = installFakeDom();
    const google = fakeGoogleId();

    const pending = signInWithGoogleNative();
    await Promise.resolve();
    await Promise.resolve();

    expect(headAppended).toHaveLength(1);
    expect(headAppended[0]?.tagName).toBe('script');

    finishScriptLoad(google);
    await Promise.resolve();
    await Promise.resolve();

    expect(bodyAppended).toHaveLength(1);
    expect(google.initialize).toHaveBeenCalledTimes(1);
    expect(google.initialize.mock.calls[0]?.[0]).toMatchObject({ client_id: 'test-web-client-id' });
    expect(google.renderButton).toHaveBeenCalledTimes(1);

    google.capturedCallback?.({ credential: 'fake-id-token' });

    await expect(pending).resolves.toBe('fake-id-token');
    // L'écran de recouvrement disparaît une fois la connexion résolue.
    expect(bodyAppended[0]?.removed).toBe(true);
  });

  it("rejette avec GoogleSignInCancelledError si l'utilisateur annule (aucun credential renvoyé)", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });
    const { finishScriptLoad } = installFakeDom();
    const google = fakeGoogleId();

    const pending = signInWithGoogleNative();
    await Promise.resolve();
    await Promise.resolve();
    finishScriptLoad(google);
    await Promise.resolve();
    await Promise.resolve();

    google.capturedCallback?.({});

    await expect(pending).rejects.toBeInstanceOf(GoogleSignInCancelledError);
  });

  it("rejette avec GoogleSignInCancelledError si l'utilisateur clique sur Annuler", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });
    const { bodyAppended, finishScriptLoad } = installFakeDom();
    const google = fakeGoogleId();

    const pending = signInWithGoogleNative();
    await Promise.resolve();
    await Promise.resolve();
    finishScriptLoad(google);
    await Promise.resolve();
    await Promise.resolve();

    const container = bodyAppended[0];
    const panel = container?.children[0];
    const dismiss = panel?.children.find((child) => child.tagName === 'button');
    dismiss?.onclick?.();

    await expect(pending).rejects.toBeInstanceOf(GoogleSignInCancelledError);
  });

  it("réutilise le script déjà chargé pour une seconde tentative -- pas un second <script>", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });
    const { headAppended, finishScriptLoad } = installFakeDom();

    const first = fakeGoogleId();
    void signInWithGoogleNative().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    finishScriptLoad(first);
    await Promise.resolve();
    await Promise.resolve();
    first.capturedCallback?.({}); // annule la première tentative, ne laisse rien en attente

    void signInWithGoogleNative().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(headAppended).toHaveLength(1);
  });
});
