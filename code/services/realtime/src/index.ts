import { parseConfig, ConfigError } from './config';
import { createRedisClient } from './redis/client';
import { createServer } from './server';

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

  server.listen(config.PORT, () => {
    console.log(`service temps réel à l'écoute sur le port ${config.PORT} (${config.NODE_ENV})`);
  });
}

main();
