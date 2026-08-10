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
