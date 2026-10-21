import { distanceMeters, isWithinRadius } from '../proximity';

const PICKUP = { latitude: 4.0511, longitude: 9.7679 };
// ~0,00045° de latitude ≈ 50 m ; 0,0018° ≈ 200 m.
const at = (dLat: number) => ({ latitude: PICKUP.latitude + dLat, longitude: PICKUP.longitude });

describe('distanceMeters', () => {
  it('vaut 0 pour le même point et approche 111 km par degré de latitude', () => {
    expect(distanceMeters(PICKUP, PICKUP)).toBe(0);
    expect(distanceMeters(at(1), PICKUP)).toBeGreaterThan(111_000);
    expect(distanceMeters(at(1), PICKUP)).toBeLessThan(111_400);
  });
});

describe('isWithinRadius -- « assez près pour être sur place »', () => {
  it('vrai à 50 m pour un rayon de 150 m, faux à 200 m', () => {
    expect(isWithinRadius(at(0.00045), PICKUP, 150)).toBe(true);
    expect(isWithinRadius(at(0.0018), PICKUP, 150)).toBe(false);
  });

  it('la frontière est incluse', () => {
    const edge = at(0.00135);
    expect(isWithinRadius(edge, PICKUP, distanceMeters(edge, PICKUP))).toBe(true);
  });

  it('faux sans position : jamais « sur place » sur une position inconnue', () => {
    expect(isWithinRadius(null, PICKUP, 150)).toBe(false);
  });
});
