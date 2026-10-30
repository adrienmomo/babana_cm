import { SCREEN_TITLES } from '../titles';

describe('titres des écrans', () => {
  it('aucun écran ne montre son nom technique de route', () => {
    for (const [route, title] of Object.entries(SCREEN_TITLES)) {
      expect(title.trim()).not.toBe('');
      expect(title).not.toBe(route);
    }
  });

  it("aucun titre de barre ne répète le titre d'étape que l'écran affiche déjà (« Course en cours » deux fois, 30 octobre)", () => {
    expect(SCREEN_TITLES.Tracking).toBe('Suivi de course');
  });
});
