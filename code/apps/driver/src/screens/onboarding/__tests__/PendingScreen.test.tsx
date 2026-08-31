import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PendingScreen } from '../PendingScreen';
import type { DocumentSlot } from '../state';

const renderedRoots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function render(slots: DocumentSlot[], onFix = jest.fn(), onRefresh = jest.fn().mockResolvedValue(undefined)) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<PendingScreen slots={slots} onFix={onFix} onRefresh={onRefresh} />);
  });
  renderedRoots.push(root);
  return { root, onFix, onRefresh };
}

describe('PendingScreen (L6-15)', () => {
  it("critère 5 -- l'état de chaque document est visible, précisément", async () => {
    const { root } = await render([
      { type: 'license', status: 'pending', rejectionReason: null, expiresOn: '2030-01-01' },
      { type: 'id_card', status: 'missing', rejectionReason: null, expiresOn: null },
    ]);
    expect(root.root.findByProps({ testID: 'pending-status-license' }).props.children).toMatch(/validation/i);
    expect(root.root.findByProps({ testID: 'pending-status-id_card' }).props.children).toMatch(/pas encore déposé/i);
  });

  it('critère 3 -- un document rejeté montre son motif et un chemin pour le corriger', async () => {
    const { root, onFix } = await render([
      { type: 'license', status: 'rejected', rejectionReason: 'Permis expiré', expiresOn: null },
      { type: 'id_card', status: 'verified', rejectionReason: null, expiresOn: null },
    ]);
    expect(root.root.findByProps({ testID: 'pending-reason-license' }).props.children).toContain('Permis expiré');

    await act(async () => {
      root.root.findByProps({ testID: 'pending-fix-license' }).props.onPress();
    });
    expect(onFix).toHaveBeenCalledWith('license');
    // Aucun bouton de correction sur le document validé.
    expect(root.root.findAllByProps({ testID: 'pending-fix-id_card' })).toHaveLength(0);
  });

  it('un document manquant propose de le déposer', async () => {
    const { root, onFix } = await render([
      { type: 'license', status: 'pending', rejectionReason: null, expiresOn: null },
      { type: 'id_card', status: 'missing', rejectionReason: null, expiresOn: null },
    ]);
    await act(async () => {
      root.root.findByProps({ testID: 'pending-fix-id_card' }).props.onPress();
    });
    expect(onFix).toHaveBeenCalledWith('id_card');
  });

  it('tout déposé -- le résumé dit que la validation est en cours, sans action demandée', async () => {
    const { root } = await render([
      { type: 'license', status: 'pending', rejectionReason: null, expiresOn: null },
      { type: 'id_card', status: 'pending', rejectionReason: null, expiresOn: null },
    ]);
    expect(root.root.findByProps({ testID: 'pending-summary' }).props.children).toMatch(/vérifie/i);
    expect(root.root.findAllByProps({ testID: 'pending-fix-license' })).toHaveLength(0);
  });

  it('actualiser relit l’état serveur', async () => {
    const { root, onRefresh } = await render([
      { type: 'license', status: 'pending', rejectionReason: null, expiresOn: null },
      { type: 'id_card', status: 'pending', rejectionReason: null, expiresOn: null },
    ]);
    await act(async () => {
      root.root.findByProps({ testID: 'pending-refresh' }).props.onPress();
    });
    expect(onRefresh).toHaveBeenCalled();
  });
});
