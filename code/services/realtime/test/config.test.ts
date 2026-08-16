import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../src/config';

const VALID_ENV = {
  REDIS_URL: 'redis://redis:6379',
  ODOO_INTERNAL_URL: 'http://odoo:8069',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
};

describe('critère 3 — le service refuse de démarrer si une variable requise manque', () => {
  test('accepte une configuration complète', () => {
    const config = parseConfig(VALID_ENV);
    assert.equal(config.REDIS_URL, VALID_ENV.REDIS_URL);
    assert.equal(config.PORT, 3000, 'PORT a une valeur par défaut');
    assert.equal(config.NODE_ENV, 'development', 'NODE_ENV a une valeur par défaut');
  });

  for (const missing of ['REDIS_URL', 'ODOO_INTERNAL_URL', 'REALTIME_SHARED_SECRET', 'JWT_SECRET']) {
    test(`rejette une configuration sans ${missing}, en nommant la variable`, () => {
      const env = { ...VALID_ENV };
      delete (env as Record<string, string>)[missing];
      assert.throws(
        () => parseConfig(env),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.ok((err as Error).message.includes(missing), `le message doit nommer ${missing}`);
          return true;
        }
      );
    });
  }
});

describe('L3-07 -- marge entre le filet Redis et le délai d\'acceptation', () => {
  test('les valeurs par défaut respectent la marge (RESERVATION_TTL_SECONDS > PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS)', () => {
    const config = parseConfig(VALID_ENV);
    assert.ok(
      config.RESERVATION_TTL_SECONDS > config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS,
      'sans cette marge, le filet Redis pourrait expirer une proposition avant le minuteur JS qui doit trancher en premier'
    );
  });

  test('refuse une configuration où le filet Redis expirerait avant (ou avec) le délai d\'acceptation', () => {
    const env = { ...VALID_ENV, RESERVATION_TTL_SECONDS: '30', PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '30' };
    assert.throws(
      () => parseConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.ok((err as Error).message.includes('RESERVATION_TTL_SECONDS'));
        return true;
      }
    );
  });
});
