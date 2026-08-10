// Squelette minimal, créé par L0-01 uniquement pour que `docker compose` dispose d'un service
// "realtime" qui démarre et répond à /health, condition du critère d'acceptation 1 de L0-01
// ("sept services sains"). L0-04 remplace entièrement ce fichier par l'implémentation
// TypeScript spécifiée dans amoa/specs/L0-socle.md (authentification WebSocket, client Redis,
// client Odoo sortant, validation de configuration au démarrage).
const http = require('node:http');

const port = process.env.PORT || 3000;

// /health (nu) : vérifié directement par le service Docker (infra/compose.yaml, healthcheck,
// sans passer par Caddy). /rt/health (préfixé) : chemin public à travers Caddy
// (infra/caddy/Caddyfile, handle /rt/* -> realtime:3000, sans réécriture de préfixe), vérifié
// par le critère d'acceptation 2 de L0-01. Les deux existent pour la même raison que /rt/ws
// (L0-04) sera préfixé côté public : convention "tout ce qui est public passe par /rt/".
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/rt/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', placeholder: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`[placeholder L0-01] service temps réel à l'écoute sur le port ${port}`);
});
