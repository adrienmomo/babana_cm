import { z } from 'zod';

/**
 * Toute la configuration vient de variables d'environnement, validées au démarrage (L0-04,
 * spécification). `parseConfig` est une fonction pure -- testable sans toucher au vrai
 * `process.env` -- appelée avec effet de bord (message nommant la variable manquante, puis
 * `process.exit(1)`) uniquement depuis index.ts, le point d'entrée réel du service.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1, 'REDIS_URL est requis'),
  ODOO_INTERNAL_URL: z.string().min(1, 'ODOO_INTERNAL_URL est requis'),
  REALTIME_SHARED_SECRET: z.string().min(1, 'REALTIME_SHARED_SECRET est requis'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET est requis'),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/**
 * Lève une ConfigError dont le message nomme précisément chaque variable manquante ou invalide
 * (critère d'acceptation 3 de L0-04) -- jamais un échec silencieux ou générique.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Configuration invalide, le service refuse de démarrer :\n${details}`
    );
  }
  return result.data;
}
