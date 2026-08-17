/**
 * openNavigation (L6-01, critère d'acceptation 3 et 4) -- testé sans SDK réel : react-native
 * lui-même est mocké par le preset jest RN, seuls Linking.openURL et AppState.addEventListener
 * sont observés/contrôlés ici.
 */
import { AppState, Linking } from 'react-native';
import { openNavigation } from '../src/providers/google/navigation';

describe('openNavigation (fournisseur Google, v1 -- lien profond D12)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ouvre un lien profond Google Maps vers la destination donnée', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    openNavigation({ latitude: 4.05, longitude: 9.7 });
    await Promise.resolve();

    expect(openURL).toHaveBeenCalledWith(
      expect.stringContaining('destination=4.05,9.7')
    );
  });

  it('ne rappelle pas onComplete tant que l\'app n\'a pas quitté puis repris le premier plan', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const listeners: Array<(state: string) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      listeners.push(handler as (state: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const onComplete = jest.fn();

    openNavigation({ latitude: 4.05, longitude: 9.7 }, { onComplete });
    await Promise.resolve();

    // Un retour au premier plan SANS être parti d'abord (événement parasite) ne doit rien
    // déclencher -- seul un aller-retour réel (quitte, puis revient) compte comme "terminé".
    listeners[0]?.('active');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rappelle onComplete quand l\'app quitte puis revient au premier plan', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const listeners: Array<(state: string) => void> = [];
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      listeners.push(handler as (state: string) => void);
      return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const onComplete = jest.fn();

    openNavigation({ latitude: 4.05, longitude: 9.7 }, { onComplete });
    await Promise.resolve();

    listeners[0]?.('background');
    listeners[0]?.('active');

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("n'échoue pas silencieusement à l'appelant si aucune app Maps n'est disponible", async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));

    expect(() => openNavigation({ latitude: 4.05, longitude: 9.7 })).not.toThrow();
    await Promise.resolve();
  });
});
