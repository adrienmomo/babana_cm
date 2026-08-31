import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RejectedScreen } from '../RejectedScreen';

const renderedRoots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function render(props: React.ComponentProps<typeof RejectedScreen>) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<RejectedScreen {...props} />);
  });
  renderedRoots.push(root);
  return root;
}

describe('RejectedScreen (amoa/questions/REPONSES-2026-09-04.md §2)', () => {
  it('un dossier rejeté affiche le motif et un chemin pour resoumettre', async () => {
    const onResubmit = jest.fn();
    const root = await render({ status: 'rejected', reason: 'Permis de conduire illisible', onResubmit });

    expect(root.root.findByProps({ testID: 'rejected-title' }).props.children).toMatch(/n'a pas été retenu/);
    expect(root.root.findByProps({ testID: 'rejected-reason' }).props.children).toBe('Permis de conduire illisible');

    await act(async () => {
      root.root.findByProps({ testID: 'rejected-resubmit' }).props.onPress();
    });
    expect(onResubmit).toHaveBeenCalledTimes(1);
  });

  it('un compte suspendu a son propre titre, le même motif visible', async () => {
    const root = await render({ status: 'suspended', reason: 'Comportement signalé', onResubmit: jest.fn() });
    expect(root.root.findByProps({ testID: 'rejected-title' }).props.children).toMatch(/suspendu/);
    expect(root.root.findByProps({ testID: 'rejected-reason' }).props.children).toBe('Comportement signalé');
  });

  it('sans motif communiqué, l’écran le dit plutôt que d’afficher un vide', async () => {
    const root = await render({ status: 'rejected', reason: null, onResubmit: jest.fn() });
    expect(root.root.findByProps({ testID: 'rejected-reason' }).props.children).toMatch(/aucun motif/i);
  });

  it('le bouton ne peut pas être déclenché deux fois de suite', async () => {
    const onResubmit = jest.fn();
    const root = await render({ status: 'rejected', reason: 'x', onResubmit });
    await act(async () => {
      root.root.findByProps({ testID: 'rejected-resubmit' }).props.onPress();
      root.root.findByProps({ testID: 'rejected-resubmit' }).props.onPress();
    });
    expect(onResubmit).toHaveBeenCalledTimes(1);
  });
});
