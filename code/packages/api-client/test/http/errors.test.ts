import { http } from '@babana/contracts';
import { ApiError, translateApiError, USER_MESSAGES } from '../../src/http/errors';

describe('USER_MESSAGES (L6-03, critère 4)', () => {
  it('a une phrase pour chaque code du catalogue C-01', () => {
    for (const code of http.ErrorCode.options) {
      expect(typeof USER_MESSAGES[code]).toBe('string');
      expect(USER_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("aucune phrase ne contient de jargon technique ('back-office', 'idempotence', 'HTTP')", () => {
    const jargon = /back-office|idempoten|HTTP|API|JSON/i;
    for (const code of http.ErrorCode.options) {
      expect(USER_MESSAGES[code]).not.toMatch(jargon);
    }
  });
});

describe('translateApiError (L6-03, critères 4 et 5)', () => {
  it('traduit un code connu par sa phrase française', () => {
    const error = new ApiError('DRIVER_ALREADY_TAKEN', 'technical message', 409);
    expect(translateApiError(error)).toBe(USER_MESSAGES.DRIVER_ALREADY_TAKEN);
  });

  it('un code inconnu produit le message générique, jamais le code brut (critère 5)', () => {
    const error = new ApiError('SOME_FUTURE_CODE' as http.ErrorCode, 'technical message', 500);
    const message = translateApiError(error);
    expect(message).not.toContain('SOME_FUTURE_CODE');
    expect(message.length).toBeGreaterThan(0);
  });
});
