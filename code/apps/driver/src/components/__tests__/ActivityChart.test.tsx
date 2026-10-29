import { barLabel, periodTitle } from '../ActivityChart';

describe('ActivityChart -- libellés de période', () => {
  it('jour : jour de la semaine, « Auj. » pour la journée en cours', () => {
    expect(barLabel('day', '2026-10-24', false)).toBe('sam.');
    expect(barLabel('day', '2026-10-26', true)).toBe('Auj.');
    expect(periodTitle('day', '2026-10-24', false)).toBe('sam. 24 octobre');
  });

  it('semaine : date du lundi', () => {
    expect(barLabel('week', '2026-10-05', false)).toBe('05/10');
    expect(periodTitle('week', '2026-10-05', false)).toBe('Semaine du 5 octobre');
    expect(periodTitle('week', '2026-10-26', true)).toBe('Cette semaine');
  });

  it('mois : mois abrégé, mois et année en titre', () => {
    expect(barLabel('month', '2026-08-01', false)).toBe('août');
    expect(periodTitle('month', '2026-08-01', false)).toBe('août 2026');
    expect(periodTitle('month', '2026-10-01', true)).toBe('Ce mois-ci');
  });

  it('une date AAAA-MM-JJ est lue en date locale, jamais décalée à la veille', () => {
    expect(barLabel('month', '2026-03-01', false)).toBe('mars');
  });
});
