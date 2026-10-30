import { SCREEN_TITLES } from '../titles';

describe('titres des écrans', () => {
  it('aucun écran ne montre son nom technique de route', () => {
    for (const [route, title] of Object.entries(SCREEN_TITLES)) {
      expect(title.trim()).not.toBe('');
      expect(title).not.toBe(route);
    }
  });
});
