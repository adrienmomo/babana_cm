// Signature JWT minimale (RS256), sans dépendance nouvelle : Node fournit tout ce qu'il faut
// (crypto, Buffer.toString('base64url')). Le seul consommateur de ces jetons ce soir est ce
// service lui-même (auto-test) ; L1-01 (hors du lot de cette nuit) écrira le contrôleur qui les
// vérifie côté Odoo, contre exactement le même format.
const crypto = require('node:crypto');

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64url');
}

function signRS256(payload, privateKey, kid) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

module.exports = { signRS256 };
