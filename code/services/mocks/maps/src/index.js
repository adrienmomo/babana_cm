// Squelette minimal (L0-01) — juste assez pour que `docker compose` construise et démarre ce
// service. Remplacé par l'implémentation complète de L0-08 : doublures d'itinéraire et de
// recherche de lieu depuis fixtures/douala.json, réponse déterministe pour un couple de points
// inconnu, simulation de panne à la demande, garde-fou NODE_ENV !== 'production'.
const http = require('node:http');

if (process.env.NODE_ENV === 'production') {
  console.error('mock-maps refuse de démarrer : NODE_ENV=production (D19).');
  process.exit(1);
}

const port = process.env.PORT || 4001;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', placeholder: true }));
    return;
  }
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'squelette L0-01, itinéraires et recherche de lieu arrivent avec L0-08' }));
});

server.listen(port, () => {
  console.log(`[placeholder L0-01] mock-maps à l'écoute sur le port ${port}`);
});
