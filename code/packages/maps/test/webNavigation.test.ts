import { openNavigation } from '../src/providers/web/navigation';

describe('openNavigation (fournisseur web, L6-18)', () => {
  afterEach(() => {
    delete (global as unknown as { window?: unknown }).window;
  });

  it('ouvre un nouvel onglet vers Google Maps avec la destination donnée', () => {
    const open = jest.fn();
    (global as unknown as { window: unknown }).window = { open };

    openNavigation({ latitude: 4.05, longitude: 9.7 });

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('destination=4.05,9.7'),
      '_blank',
      'noopener,noreferrer'
    );
  });

  it("ne fait rien hors d'un navigateur, sans lever", () => {
    expect(() => openNavigation({ latitude: 4.05, longitude: 9.7 })).not.toThrow();
  });
});
