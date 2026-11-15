import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { makeStyles } from './theme';

/**
 * Messages rapides pendant une course (chauffeur <-> client) : une rangée de pastilles à toucher,
 * et la bulle du dernier message reçu. Génériques -- les codes et les libellés viennent de l'app
 * appelante (`@babana/api-client`, `QUICK_MESSAGE_LABELS`) ; ce paquet ne connaît pas le contrat.
 *
 * Mêmes formes et couleurs que les boutons de l'app Chauffeur (pilules, palette douce).
 */
export interface QuickMessageOption<Code extends string = string> {
  code: Code;
  label: string;
}

export interface QuickMessageChipsProps<Code extends string> {
  options: QuickMessageOption<Code>[];
  onSend: (code: Code) => void;
  disabled?: boolean;
  testID?: string;
}

export function QuickMessageChips<Code extends string>({ options, onSend, disabled = false, testID }: QuickMessageChipsProps<Code>) {
  const styles = useStyles();
  return (
    // flexGrow: 0 -- dans une colonne, une ScrollView horizontale prend toute la hauteur libre et
    // étire chaque pastille en ovale géant (vu sur l'écran de suivi du client, 30 octobre).
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.row}
      testID={testID}
    >
      {options.map((option) => (
        <Pressable
          key={option.code}
          testID={`quick-message-${option.code}`}
          accessibilityRole="button"
          accessibilityLabel={`Envoyer : ${option.label}`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => onSend(option.code)}
          style={({ pressed }) => [styles.chip, disabled ? styles.disabled : null, pressed ? styles.pressed : null]}
        >
          <Text style={styles.chipLabel}>{option.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export interface MessageBubbleProps {
  /** Qui parle : « Client », « Votre chauffeur ». */
  author: string;
  text: string;
  onDismiss: () => void;
  testID?: string;
}

export function MessageBubble({ author, text, onDismiss, testID }: MessageBubbleProps) {
  const styles = useStyles();
  return (
    <View style={styles.bubble} testID={testID} accessibilityLiveRegion="polite">
      <View style={styles.bubbleBody}>
        <Text style={styles.author}>{author}</Text>
        <Text style={styles.text}>{text}</Text>
      </View>
      <Pressable
        testID={testID ? `${testID}-dismiss` : undefined}
        accessibilityRole="button"
        accessibilityLabel="Fermer le message"
        hitSlop={12}
        onPress={onDismiss}
        style={styles.close}
      >
        <Text style={styles.closeLabel}>×</Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  scroller: {
    flexGrow: 0,
    flexShrink: 0,
  },
  row: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: {
    color: c.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    backgroundColor: c.brandSoft,
    borderWidth: 1,
    borderColor: c.brandBorder,
  },
  bubbleBody: {
    flex: 1,
    gap: 2,
  },
  author: {
    color: c.brandText,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  text: {
    color: c.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  close: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeLabel: {
    color: c.muted,
    fontSize: 22,
    lineHeight: 24,
  },
}));
