import { computeReconnectDelayMs } from '../../src/realtime/reconnect';

describe('computeReconnectDelayMs (L6-04, critère 1 ; L3-11)', () => {
  it('croît avec le nombre de tentatives (temporisation croissante)', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0 }; // gigue nulle pour isoler la croissance
    expect(computeReconnectDelayMs(0, config)).toBe(1000);
    expect(computeReconnectDelayMs(1, config)).toBe(2000);
    expect(computeReconnectDelayMs(2, config)).toBe(4000);
    expect(computeReconnectDelayMs(3, config)).toBe(8000);
  });

  it('est plafonnée à maxDelayMs, même après de nombreuses tentatives', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0 };
    expect(computeReconnectDelayMs(20, config)).toBe(10_000);
  });

  it('applique une gigue aléatoire -- deux appels à la même tentative ne donnent pas systématiquement le même délai', () => {
    const config = { baseDelayMs: 5000, maxDelayMs: 60_000, jitterRatio: 0.5 };
    const samples = new Set(Array.from({ length: 20 }, () => computeReconnectDelayMs(2, config)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('la gigue reste dans les bornes attendues, jamais négative', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.3 };
    for (let i = 0; i < 50; i++) {
      const delay = computeReconnectDelayMs(1, config); // exponentiel = 2000, ±30% -> [1400, 2600]
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2600);
    }
  });
});
