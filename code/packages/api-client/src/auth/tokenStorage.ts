import * as Keychain from 'react-native-keychain';

/**
 * Jetons dans le stockage sécurisé du système -- trousseau iOS, Keystore Android (L6-02, critère
 * d'acceptation 1) -- jamais un stockage clé-valeur ordinaire (AsyncStorage, par exemple, non
 * chiffré et lisible par toute app avec accès au système de fichiers sur un appareil rooté).
 */
const KEYCHAIN_SERVICE = 'cm.babana.auth';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch millisecondes -- calculé une fois à la réception de `expiresIn` (secondes), jamais
   * recalculé depuis `Date.now()` à la lecture (la session survit un redémarrage de l'app). */
  expiresAt: number;
}

/** Interface d'injection -- testable sans trousseau réel (critère d'acceptation 4, L6-01, même
 * discipline appliquée ici : aucun test de ce module ne touche le Keychain/Keystore réel). */
export interface TokenStorage {
  save(session: StoredSession): Promise<void>;
  load(): Promise<StoredSession | null>;
  clear(): Promise<void>;
}

function serialize(session: StoredSession): string {
  return JSON.stringify(session);
}

function deserialize(raw: string): StoredSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export const secureTokenStorage: TokenStorage = {
  async save(session) {
    await Keychain.setGenericPassword(KEYCHAIN_SERVICE, serialize(session), {
      service: KEYCHAIN_SERVICE,
    });
  },

  async load() {
    const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (!result) return null;
    return deserialize(result.password);
  },

  async clear() {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  },
};
