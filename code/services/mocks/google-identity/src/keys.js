// Jeu de clés généré au démarrage (L0-08, spécification). Deux paires : "primary" est publiée
// dans /.well-known/jwks.json et sert à signer les jetons valides ; "rogue" n'est jamais
// publiée et sert uniquement à produire le cas d'invalidité "signature d'une autre clé" -- un
// jeton signé par "rogue" ne peut jamais être validé contre les clés publiques exposées ici,
// exactement comme un vrai jeton signé par un tiers non reconnu.
const crypto = require('node:crypto');

function generateKeyPair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    publicKey,
    jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' },
  };
}

const primary = generateKeyPair('mock-google-identity-primary');
const rogue = generateKeyPair('mock-google-identity-rogue');

function jwks() {
  return { keys: [primary.jwk] };
}

module.exports = { primary, rogue, jwks };
