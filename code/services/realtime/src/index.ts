import { parseConfig, ConfigError } from './config';
import { createRedisClient } from './redis/client';
import { createServer } from './server';
import { startReservationExpiryWatcher } from './reservation/reserve';

function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const redis = createRedisClient(config);
  const server = createServer(config, redis);
  // Libère automatiquement un chauffeur dont la réservation a expiré sans jamais avoir abouti à
  // une proposition (L3-06, critère 5) -- un processus par service, pas par connexion.
  startReservationExpiryWatcher(redis);

  server.listen(config.PORT, () => {
    console.log(`service temps réel à l'écoute sur le port ${config.PORT} (${config.NODE_ENV})`);
  });
}

main();
