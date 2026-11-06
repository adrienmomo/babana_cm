// Dev server 75.119.155.162 -- Node processes under pm2, as user babana.
//
//   sudo -u babana pm2 start infra/devserver/pm2/ecosystem.config.cjs && sudo -u babana pm2 save
//
// The realtime service reads its configuration from the shared env file through Node's own
// --env-file (pm2 has no env-file support). Values set in `env` below win over the file.
const path = require('node:path');

const CODE_DIR = path.resolve(__dirname, '../../..');
const ENV_FILE = process.env.BABANA_ENV_FILE || '/etc/babana/babana.env';
const LOG_DIR = process.env.BABANA_LOG_DIR || '/var/lib/babana/logs';

module.exports = {
  apps: [
    {
      name: 'babana-realtime',
      cwd: path.join(CODE_DIR, 'services/realtime'),
      script: 'dist/index.js',
      node_args: `--env-file=${ENV_FILE}`,
      env: { NODE_ENV: 'production', PORT: '3000' },
      // One process: the realtime service keeps its proposal timers and WebSocket subscriptions
      // in memory (L3-14 covers restarts, not several live copies).
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '700M',
      kill_timeout: 10000,
      out_file: path.join(LOG_DIR, 'realtime.out.log'),
      error_file: path.join(LOG_DIR, 'realtime.err.log'),
      time: true,
    },
    {
      // Routing for Odoo's fare quotes only, on 127.0.0.1 (no Google Routes adapter yet --
      // amoa/questions/DEVSERVER-2026-11-05.md §4). Never proxied by nginx.
      name: 'babana-mock-maps',
      cwd: path.join(CODE_DIR, 'services/mocks/maps'),
      script: 'src/index.js',
      // Simulators refuse NODE_ENV=production (D19, L0-08 criterion 6): this server is not
      // production, and the guard is right -- development, as in compose.dev.yaml.
      env: { NODE_ENV: 'development', PORT: '4001' },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '200M',
      out_file: path.join(LOG_DIR, 'mock-maps.out.log'),
      error_file: path.join(LOG_DIR, 'mock-maps.err.log'),
      time: true,
    },
  ],
};
