import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from 'react-native';

/**
 * Thèmes des deux apps (15 novembre) : clair, sombre, noir, ou celui du téléphone. Le choix est
 * gardé sur le téléphone (`ThemeStorage`, fourni par l'app : ce paquet n'a pas de stockage à lui),
 * jamais sur le serveur -- c'est une préférence d'affichage, pas une donnée métier.
 *
 * Les couleurs sont des rôles (`ink`, `surface`, `brand`…), pas des teintes : un écran ne dit jamais
 * « blanc », il dit « surface ». `makeStyles` reconstruit les styles d'un écran quand le thème
 * change, une fois par palette (mis en cache), pas à chaque rendu.
 *
 * « Noir » : fonds vraiment noirs, pour les écrans OLED (la batterie d'un chauffeur de nuit) ; les
 * textes et accents sont ceux du thème sombre.
 */

export type ThemeMode = 'system' | 'light' | 'dark' | 'black';
export type ColorScheme = 'light' | 'dark' | 'black';

export interface Palette {
  scheme: ColorScheme;
  isDark: boolean;
  brand: string;
  brandPressed: string;
  brandSoft: string;
  brandBorder: string;
  brandText: string;
  /** Texte et icônes posés sur `brand` (bouton principal). */
  onBrand: string;
  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  dangerText: string;
  warning: string;
  warningSoft: string;
  warningBorder: string;
  warningText: string;
  info: string;
  infoSoft: string;
  infoText: string;
  route: string;
  ink: string;
  inkSoft: string;
  muted: string;
  subtle: string;
  border: string;
  borderStrong: string;
  surface: string;
  surfaceGlass: string;
  /** Fond d'un champ, d'une carte en retrait, d'un emplacement vide. */
  surfaceMuted: string;
  canvas: string;
  /** Voile derrière une feuille ou une fenêtre. */
  overlay: string;
  shadow: string;
}

const LIGHT: Palette = {
  scheme: 'light',
  isDark: false,
  brand: '#1A9E5C',
  brandPressed: '#15854D',
  brandSoft: '#E8F6EE',
  brandBorder: '#B8E2CB',
  brandText: '#137347',
  onBrand: '#FFFFFF',
  danger: '#E5484D',
  dangerSoft: '#FDEEEE',
  dangerBorder: '#F5C6C7',
  dangerText: '#C2363B',
  warning: '#F59E0B',
  warningSoft: '#FFF6E3',
  warningBorder: '#F6DFAE',
  warningText: '#8A5A00',
  info: '#2563EB',
  infoSoft: '#EFF6FF',
  infoText: '#1D4ED8',
  route: '#3E7BFA',
  ink: '#1F2937',
  inkSoft: '#374151',
  muted: '#6B7280',
  subtle: '#9CA3AF',
  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
  surface: '#FFFFFF',
  surfaceGlass: 'rgba(255, 255, 255, 0.96)',
  surfaceMuted: '#F9FAFB',
  canvas: '#F7F8FA',
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: '#000000',
};

const DARK: Palette = {
  scheme: 'dark',
  isDark: true,
  brand: '#22B36A',
  brandPressed: '#1A9E5C',
  brandSoft: '#123222',
  brandBorder: '#1F5A3A',
  brandText: '#4ADE80',
  onBrand: '#FFFFFF',
  danger: '#F87171',
  dangerSoft: '#3A1D1F',
  dangerBorder: '#5C2B2E',
  dangerText: '#FCA5A5',
  warning: '#FBBF24',
  warningSoft: '#3A2E12',
  warningBorder: '#5C4A1C',
  warningText: '#FCD34D',
  info: '#60A5FA',
  infoSoft: '#172554',
  infoText: '#93C5FD',
  route: '#60A5FA',
  ink: '#F3F4F6',
  inkSoft: '#D1D5DB',
  muted: '#9CA3AF',
  subtle: '#6B7280',
  border: '#2E333A',
  borderStrong: '#3F4650',
  surface: '#1C1F24',
  surfaceGlass: 'rgba(28, 31, 36, 0.96)',
  surfaceMuted: '#24282E',
  canvas: '#121417',
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000000',
};

const BLACK: Palette = {
  ...DARK,
  scheme: 'black',
  border: '#232323',
  borderStrong: '#333333',
  surface: '#0B0B0B',
  surfaceGlass: 'rgba(11, 11, 11, 0.96)',
  surfaceMuted: '#151515',
  canvas: '#000000',
  overlay: 'rgba(0, 0, 0, 0.75)',
};

export const PALETTES: Record<ColorScheme, Palette> = { light: LIGHT, dark: DARK, black: BLACK };

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark', 'black'];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: 'Téléphone',
  light: 'Clair',
  dark: 'Sombre',
  black: 'Noir',
};

/** Où l'app garde le choix (AsyncStorage dans les deux apps). Un échec ne fait jamais tomber l'écran. */
export interface ThemeStorage {
  get(): Promise<string | null>;
  set(mode: ThemeMode): Promise<void>;
}

export function resolveScheme(mode: ThemeMode, system: string | null | undefined): ColorScheme {
  if (mode === 'system') return system === 'dark' ? 'dark' : 'light';
  return mode;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

interface ThemeValue {
  mode: ThemeMode;
  colors: Palette;
  setMode: (mode: ThemeMode) => void;
}

// Sans fournisseur (tests d'écran, composant isolé) : le thème clair, celui d'avant cette séance.
const ThemeContext = createContext<ThemeValue>({ mode: 'system', colors: LIGHT, setMode: () => undefined });

export function ThemeProvider({ storage, children }: { storage?: ThemeStorage; children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let cancelled = false;
    storage
      ?.get()
      .then((saved) => {
        if (!cancelled && isThemeMode(saved)) setModeState(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      storage?.set(next).catch(() => undefined);
    },
    [storage]
  );

  const scheme = resolveScheme(mode, system);
  const value = useMemo(() => ({ mode, colors: PALETTES[scheme], setMode }), [mode, scheme, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * Styles d'un écran fonction du thème : `const useStyles = makeStyles((c) => ({ … }))` au niveau du
 * module, `const styles = useStyles()` dans le composant. Un objet de styles par palette, construit
 * à la première demande puis réutilisé.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (colors: Palette) => T): () => T {
  const cache = new Map<ColorScheme, T>();
  return function useStyles(): T {
    const { colors } = useTheme();
    let styles = cache.get(colors.scheme);
    if (!styles) {
      styles = StyleSheet.create(factory(colors));
      cache.set(colors.scheme, styles);
    }
    return styles;
  };
}

/** Le choix d'apparence, tel que les deux apps le montrent dans « Mon compte ». */
export function ThemePicker({ testID = 'theme-picker' }: { testID?: string }) {
  const { mode, setMode } = useTheme();
  const styles = usePickerStyles();
  return (
    <View testID={testID}>
      <Text style={styles.title}>Apparence</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {THEME_MODES.map((option) => {
          const selected = option === mode;
          return (
            <Pressable
              key={option}
              testID={`${testID}-${option}`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setMode(option)}
              style={[styles.option, selected ? styles.optionSelected : null]}
            >
              <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>{THEME_MODE_LABELS[option]}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const usePickerStyles = makeStyles((c) => ({
  title: { fontSize: 15, fontWeight: '600', color: c.ink, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  option: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionSelected: { borderColor: c.brand, backgroundColor: c.brandSoft },
  optionLabel: { fontSize: 15, color: c.inkSoft },
  optionLabelSelected: { color: c.brandText, fontWeight: '600' },
}));

/**
 * Champ de saisie au thème : texte en `ink`, indication en `subtle`. Sans eux, un `TextInput` garde
 * le noir du système, illisible sur les fonds sombres.
 */
export const TextField = React.forwardRef<TextInput, TextInputProps>(function TextField({ style, placeholderTextColor, ...props }, ref) {
  const { colors } = useTheme();
  return <TextInput ref={ref} {...props} style={[{ color: colors.ink }, style]} placeholderTextColor={placeholderTextColor ?? colors.subtle} />;
});
