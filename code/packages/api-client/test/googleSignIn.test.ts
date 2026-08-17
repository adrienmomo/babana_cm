import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import {
  GooglePlayServicesUnavailableError,
  _resetGoogleSignInConfigForTests,
  configureGoogleSignIn,
  signInWithGoogleNative,
} from '../src/auth/googleSignIn';

describe('signInWithGoogleNative (L6-02, chemin natif -- D22)', () => {
  afterEach(() => {
    _resetGoogleSignInConfigForTests();
    jest.restoreAllMocks();
  });

  it('exige configureGoogleSignIn avant tout appel', async () => {
    await expect(signInWithGoogleNative()).rejects.toThrow(/configureGoogleSignIn/);
  });

  it('renvoie l\'ID token du double officiel de la bibliothèque quand tout va bien', async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });

    await expect(signInWithGoogleNative()).resolves.toBe('mockIdToken');
  });

  it("produit une erreur dédiée et une métrique si Google Play Services est indisponible (critère d'acceptation 4)", async () => {
    configureGoogleSignIn({ webClientId: 'test-web-client-id' });
    const error = Object.assign(new Error('unavailable'), {
      code: statusCodes.PLAY_SERVICES_NOT_AVAILABLE,
    });
    jest.spyOn(GoogleSignin, 'hasPlayServices').mockRejectedValue(error);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(signInWithGoogleNative()).rejects.toBeInstanceOf(GooglePlayServicesUnavailableError);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('google_play_services_unavailable'),
      expect.anything()
    );
  });
});
