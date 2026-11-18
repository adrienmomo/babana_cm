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
  test('18 novembre : le délai d\'acceptation n\'est plus une variable du service -- Odoo en est la seule source', () => {
    const config = parseConfig({ ...VALID_ENV, PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '99', RESERVATION_TTL_SECONDS: '99' });
    assert.equal('PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS' in config, false);
    assert.equal('RESERVATION_TTL_SECONDS' in config, false);
  });

  test('la marge du filet Redis vaut 30 s par défaut', () => {
    assert.equal(parseConfig(VALID_ENV).RESERVATION_TTL_MARGIN_SECONDS, 30);
  });

  test('refuse une marge nulle : le filet Redis expirerait avec le minuteur au lieu d\'après lui', () => {
    assert.throws(
      () => parseConfig({ ...VALID_ENV, RESERVATION_TTL_MARGIN_SECONDS: '0' }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.ok((err as Error).message.includes('RESERVATION_TTL_MARGIN_SECONDS'));
        return true;
      }
    );
  });
});
