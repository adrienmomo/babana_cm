import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SwipeButton, isSwipeConfirmed, SWIPE_CONFIRM_RATIO } from '../SwipeButton';

const WIDTH = 360;
// Course du curseur = largeur − curseur (48) − marges (2 × 4).
const TRAVEL = WIDTH - 48 - 8;

describe('isSwipeConfirmed', () => {
  it('confirme au-delà du seuil, pas en deçà', () => {
    expect(isSwipeConfirmed(TRAVEL * SWIPE_CONFIRM_RATIO, WIDTH)).toBe(true);
    expect(isSwipeConfirmed(TRAVEL, WIDTH)).toBe(true);
    expect(isSwipeConfirmed(TRAVEL * SWIPE_CONFIRM_RATIO - 1, WIDTH)).toBe(false);
    expect(isSwipeConfirmed(20, WIDTH)).toBe(false);
  });

  it('jamais avant que la piste ne soit mesurée', () => {
    expect(isSwipeConfirmed(500, 0)).toBe(false);
  });
});

async function render(props: Partial<React.ComponentProps<typeof SwipeButton>> = {}) {
  const onConfirm = jest.fn();
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<SwipeButton label="Glisser pour commencer" onConfirm={onConfirm} testID="swipe" {...props} />);
  });
  const host = root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'swipe')[0]!;
  await act(async () => {
    host.props.onLayout({ nativeEvent: { layout: { width: WIDTH, height: 56, x: 0, y: 0 } } });
  });
  const knob = root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'swipe-knob')[0]!;
  return { root, host, knob, onConfirm };
}

/** Un appui sans glissement sur le curseur (le geste complet est couvert par isSwipeConfirmed et
 * vérifié sur l'émulateur -- le moteur de geste natif n'existe pas sous Jest). */
function tap(knob: { props: Record<string, (...args: unknown[]) => unknown> }) {
  const event = { nativeEvent: { touches: [], changedTouches: [] }, touchHistory: { touchBank: [] } };
  knob.props.onResponderGrant?.(event);
  knob.props.onResponderRelease?.(event);
}

describe('SwipeButton', () => {
  it('un simple appui ne confirme rien', async () => {
    const { knob, onConfirm } = await render();
    await act(async () => {
      tap(knob);
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("l'action d'accessibilité « activate » confirme (un lecteur d'écran ne glisse pas)", async () => {
    const { host, onConfirm } = await render();
    await act(async () => {
      host.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('désactivé : ni le geste ni l’accessibilité ne confirment', async () => {
    const { host, onConfirm } = await render({ disabled: true });
    await act(async () => {
      host.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(host.props.accessibilityState).toEqual({ disabled: true });
  });

  it('affiche son libellé', async () => {
    const { root } = await render();
    expect(JSON.stringify(root.toJSON())).toContain('Glisser pour commencer');
  });
});
