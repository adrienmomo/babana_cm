// Encodage de polyline au format Google (precision 1e5), pour que packages/maps (L6-01, hors
// du lot de cette nuit) puisse être développé contre un format réaliste dès maintenant et
// basculer vers le vrai fournisseur sans changement de code (C3, D13).
function encodeNumber(num) {
  let output = '';
  let value = num;
  while (value >= 0x20) {
    output += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  output += String.fromCharCode(value + 63);
  return output;
}

function encodeSignedNumber(num) {
  let signedNum = num << 1;
  if (num < 0) signedNum = ~signedNum;
  return encodeNumber(signedNum);
}

function encodePolyline(points) {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const lat5 = Math.round(lat * 1e5);
    const lng5 = Math.round(lng * 1e5);
    output += encodeSignedNumber(lat5 - prevLat);
    output += encodeSignedNumber(lng5 - prevLng);
    prevLat = lat5;
    prevLng = lng5;
  }
  return output;
}

module.exports = { encodePolyline };
