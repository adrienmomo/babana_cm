// Squelette minimal (L0-01) — juste assez pour que `docker compose` construise et démarre ce
// service, sans bloquer make up ce soir. Remplacé par l'implémentation complète de L0-08 :
// jeu de clés JWKS généré au démarrage, émission de jetons signés (valides et volontairement
// invalides selon cinq défauts distincts), garde-fou NODE_ENV !== 'production'.
const http = require('node:http');

if (process.env.NODE_ENV === 'production') {
  console.error('mock-google-identity refuse de démarrer : NODE_ENV=production (D19).');
  process.exit(1);
}

const port = process.env.PORT || 4000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', placeholder: true }));
    return;
  }
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'squelette L0-01, /.well-known/jwks.json et /token arrivent avec L0-08' }));
});

server.listen(port, () => {
  console.log(`[placeholder L0-01] mock-google-identity à l'écoute sur le port ${port}`);
});
