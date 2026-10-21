import React, { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { buttonLabels, buttons, colors, radius } from '../theme';

/**
 * « Glisser pour … » : l'action principale d'une course (Sur place, Commencer, Terminer). Un
 * glissement complet est bien plus difficile à déclencher par erreur qu'un appui -- en roulant,
 * avec des gants, ou par un double appui qui tomberait sur le bouton suivant -- et se fait sans
 * regarder l'écran. Même geste que les grandes apps de VTC.
 *
 * Aucune dépendance nouvelle : `PanResponder` + `Animated` de react-native. Un lecteur d'écran ne
 * glisse pas -- l'action d'accessibilité `activate` confirme directement.
 */
export interface SwipeButtonProps {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

const KNOB_SIZE = 48;
const TRACK_PADDING = 4;
/** Part de la course du curseur à atteindre pour confirmer -- le reste revient en place. */
export const SWIPE_CONFIRM_RATIO = 0.85;

/** Le glissement `dx` (px) suffit-il, sur une piste de `trackWidth` px, à confirmer ? */
export function isSwipeConfirmed(dx: number, trackWidth: number): boolean {
  const travel = trackWidth - KNOB_SIZE - TRACK_PADDING * 2;
  if (travel <= 0) return false;
  return dx >= travel * SWIPE_CONFIRM_RATIO;
}

export function SwipeButton({ label, onConfirm, disabled = false, testID, accessibilityLabel }: SwipeButtonProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const offset = useRef(new Animated.Value(0)).current;
  // Lus par le PanResponder, créé une seule fois.
  const latest = useRef({ trackWidth: 0, disabled, onConfirm });
  latest.current = { trackWidth, disabled, onConfirm };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onMoveShouldSetPanResponder: (_e, g) => !latest.current.disabled && Math.abs(g.dx) > 4,
        onPanResponderMove: (_e, g) => {
          const travel = Math.max(0, latest.current.trackWidth - KNOB_SIZE - TRACK_PADDING * 2);
          offset.setValue(Math.min(Math.max(0, g.dx), travel));
        },
        onPanResponderRelease: (_e, g) => {
          if (isSwipeConfirmed(g.dx, latest.current.trackWidth)) {
            latest.current.onConfirm();
          }
          Animated.spring(offset, { toValue: 0, useNativeDriver: false, bounciness: 4 }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(offset, { toValue: 0, useNativeDriver: false }).start();
        },
      }),
    [offset]
  );

  const travel = Math.max(1, trackWidth - KNOB_SIZE - TRACK_PADDING * 2);
  const labelOpacity = offset.interpolate({ inputRange: [0, travel * 0.6], outputRange: [1, 0], extrapolate: 'clamp' });

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint="Glissez vers la droite pour confirmer"
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate' && !disabled) onConfirm();
      }}
      onLayout={(event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[buttons.base, buttons.lg, buttons.primary, buttons.floating, styles.track, disabled ? buttons.disabled : null]}
    >
      <Animated.Text style={[buttonLabels.lg, buttonLabels.primary, styles.label, { opacity: labelOpacity }]}>
        {label}
      </Animated.Text>
      <Animated.View
        {...responder.panHandlers}
        style={[styles.knob, { transform: [{ translateX: offset }] }]}
        testID={testID ? `${testID}-knob` : undefined}
      >
        <Text style={styles.chevron}>›</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    alignSelf: 'stretch',
    paddingHorizontal: 0,
    justifyContent: 'center',
  },
  label: {
    paddingHorizontal: KNOB_SIZE + 12,
    textAlign: 'center',
  },
  knob: {
    position: 'absolute',
    left: TRACK_PADDING,
    top: TRACK_PADDING - 1,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    color: colors.brand,
    fontSize: 30,
    fontWeight: '700',
    marginTop: -4,
  },
});
