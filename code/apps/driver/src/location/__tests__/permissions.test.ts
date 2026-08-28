import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import { ensureBackgroundPermission, ensureForegroundPermission } from '../permissions';

describe('permissions (L6-05, critère 5 -- un refus ne bloque jamais l’app)', () => {
  const ORIGINAL_OS = Platform.OS;

  afterEach(() => {
    jest.restoreAllMocks();
    // Platform.OS est une assignation directe (jest.spyOn(..., 'get') échoue sur ce module RN),
    // jamais restaurée par restoreAllMocks() -- fuiterait sinon vers d'autres fichiers de test.
    Platform.OS = ORIGINAL_OS;
  });

  describe('ensureForegroundPermission', () => {
    test('Android, accordée -- renvoie granted', async () => {
      Platform.OS = 'android';
      jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);

      await expect(ensureForegroundPermission()).resolves.toBe('granted');
    });

    test('Android, refusée -- renvoie denied, ne lève jamais', async () => {
      Platform.OS = 'android';
      jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);

      await expect(ensureForegroundPermission()).resolves.toBe('denied');
    });

    test('iOS -- demande l’autorisation native et considère la permission acquise (résultat réel appris au premier relevé)', async () => {
      Platform.OS = 'ios';
      const spy = jest.spyOn(Geolocation, 'requestAuthorization');

      await expect(ensureForegroundPermission()).resolves.toBe('granted');
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('ensureBackgroundPermission', () => {
    test('Android, accordée -- renvoie granted', async () => {
      Platform.OS = 'android';
      jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);

      await expect(ensureBackgroundPermission()).resolves.toBe('granted');
    });

    test('Android, refusée -- renvoie denied (dégrade la continuité en arrière-plan, ne bloque rien)', async () => {
      Platform.OS = 'android';
      jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);

      await expect(ensureBackgroundPermission()).resolves.toBe('denied');
    });

    test('iOS -- non modélisée, renvoie denied explicitement (amoa/questions/L6-05.md)', async () => {
      Platform.OS = 'ios';

      await expect(ensureBackgroundPermission()).resolves.toBe('denied');
    });
  });
});
