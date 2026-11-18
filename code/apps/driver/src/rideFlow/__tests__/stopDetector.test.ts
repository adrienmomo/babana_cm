import { StopDetector, distanceMeters, type DetectorFix } from '../stopDetector';

const CONFIG = { arrivalRadiusMeters: 50, departureDistanceMeters: 60, departureSpeedKmh: 8, departureDurationSeconds: 10 };
const STOP = { latitude: 4.05, longitude: 9.7 };
// ~11 m par pas de 0.0001° de latitude.
const north = (meters: number) => ({ latitude: STOP.latitude + meters / 111_320, longitude: STOP.longitude });

function fix(meters: number, atS: number, speed: number | null = null): DetectorFix {
  return { ...north(meters), speedMetersPerSecond: speed, atMs: atS * 1000 };
}

describe('StopDetector (L6-21)', () => {
  it('arrivée : dans le rayon du serveur, une seule fois', () => {
    const detector = new StopDetector(CONFIG);
    const target = { kind: 'arrival' as const, stopId: 's1', position: STOP };
    expect(detector.feed(fix(120, 0), target)).toBeNull();
    expect(detector.feed(fix(40, 5), target)).toEqual({ type: 'arrived', stopId: 's1', atMs: 5000 });
    expect(detector.feed(fix(10, 10), target)).toBeNull();
  });

  it('les seuils du serveur font foi : un rayon plus grand déclenche plus tôt', () => {
    const detector = new StopDetector({ ...CONFIG, arrivalRadiusMeters: 150 });
    expect(detector.feed(fix(120, 0), { kind: 'arrival', stopId: 's1', position: STOP })).not.toBeNull();
  });

  it('critère 2 : un mouvement continu au-delà des seuils donne exactement UN départ, daté de son début', () => {
    const detector = new StopDetector(CONFIG);
    const target = { kind: 'departure' as const, stopId: 's1', anchor: STOP };
    const events = [];
    // Immobile, puis 4 m/s (14 km/h) à partir de t=20 s, un relevé toutes les 2 s.
    for (let t = 0; t < 20; t += 2) events.push(detector.feed(fix(0, t, 0), target));
    for (let t = 20; t <= 60; t += 2) events.push(detector.feed(fix((t - 20) * 4, t, 4), target));
    const departures = events.filter(Boolean);
    expect(departures).toEqual([{ type: 'departed', stopId: 's1', atMs: 20_000 }]);
  });

  it('critère 2 : un mouvement trop court n’en donne aucun', () => {
    const detector = new StopDetector(CONFIG);
    const target = { kind: 'departure' as const, stopId: 's1', anchor: STOP };
    const events = [];
    // 6 s à 4 m/s (en dessous des 10 s), puis arrêt -- la moto se gare un peu plus loin.
    for (let t = 0; t <= 6; t += 2) events.push(detector.feed(fix(t * 4, t, 4), target));
    for (let t = 8; t <= 40; t += 2) events.push(detector.feed(fix(24, t, 0), target));
    expect(events.filter(Boolean)).toEqual([]);
  });

  it('assez longtemps mais sur place (bruit, manœuvre) : pas de départ sous la distance', () => {
    const detector = new StopDetector(CONFIG);
    const target = { kind: 'departure' as const, stopId: 's1', anchor: STOP };
    const events = [];
    for (let t = 0; t <= 30; t += 2) events.push(detector.feed(fix(t % 4 === 0 ? 10 : 0, t, 3), target));
    expect(events.filter(Boolean)).toEqual([]);
  });

  it('vitesse GPS absente : déduite des relevés successifs', () => {
    const detector = new StopDetector(CONFIG);
    const target = { kind: 'departure' as const, stopId: null, anchor: STOP };
    let event = null;
    for (let t = 0; t <= 40 && !event; t += 2) event = detector.feed(fix(t * 4, t, null), target);
    expect(event).toEqual({ type: 'departed', stopId: null, atMs: 2000 });
  });

  it('une nouvelle cible repart de zéro (arrêt suivant)', () => {
    const detector = new StopDetector(CONFIG);
    expect(detector.feed(fix(10, 0), { kind: 'arrival', stopId: 's1', position: STOP })).not.toBeNull();
    expect(detector.feed(fix(10, 2), { kind: 'arrival', stopId: 's2', position: STOP })).not.toBeNull();
  });

  it('distanceMeters : ordre de grandeur juste à Douala', () => {
    expect(Math.round(distanceMeters(STOP, north(100)))).toBe(100);
  });
});
