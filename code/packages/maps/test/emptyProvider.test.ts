/**
 * Le fournisseur vide (`providers/empty`) compile contre `MapProvider` sans jamais importer un
 * SDK de carte -- c'est le critère d'acceptation 5, "le vrai test" de l'abstraction (spécification
 * L6-01). L'assignation `const _typeCheck: MapProvider = emptyMapProvider` ci-dessous EST la
 * preuve : si `providers/empty/index.tsx` cessait de satisfaire l'interface, `npm run typecheck`
 * échouerait avant que ce fichier n'exécute quoi que ce soit.
 */
import type { MapProvider } from '../src/types';
import { emptyMapProvider } from '../src/providers/empty';

function assertSatisfiesMapProvider(_provider: MapProvider): void {}
assertSatisfiesMapProvider(emptyMapProvider);

describe('emptyMapProvider (preuve de compilation, aucun SDK réel)', () => {
  it('échoue explicitement plutôt que de se comporter en silence', () => {
    expect(() => emptyMapProvider.openNavigation({ latitude: 0, longitude: 0 })).toThrow(
      /openNavigation/
    );
  });

  it('searchPlace échoue explicitement', async () => {
    await expect(emptyMapProvider.searchPlace('Akwa')).rejects.toThrow(/searchPlace/);
  });

  it('reverseGeocode échoue explicitement', async () => {
    await expect(
      emptyMapProvider.reverseGeocode({ latitude: 0, longitude: 0 })
    ).rejects.toThrow(/reverseGeocode/);
  });
});
