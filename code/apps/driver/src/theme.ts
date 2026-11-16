import { StyleSheet } from 'react-native';
import { PALETTES, makeStyles, useTheme, type ColorScheme, type Palette } from '@babana/ui';

/**
 * Palette et formes de l'app Chauffeur -- un seul endroit, pour que chaque bouton et chaque carte
 * parlent la même langue visuelle : couleurs douces, boutons en pilule, une seule ombre.
 *
 * Règle d'usage : **l'action principale d'un moment est toujours `primary`** (vert plein) -- une
 * seule par écran ; tout le reste est `secondary` (blanc, bordure fine). Le rouge est réservé à
 * l'urgence et aux erreurs, en teinte douce (`dangerSoft`) plutôt qu'en aplat.
 *
 * Les couleurs sont celles du thème choisi (15 novembre : clair, sombre, noir ou celui du
 * téléphone -- `ThemeProvider` de @babana/ui). Dans un composant : `useColors()` ; dans des styles :
 * `makeStyles((c) => …)`. `colors` reste la palette claire, pour les tests qui comparent une teinte.
 */
export const colors = PALETTES.light;
export { makeStyles };

export function useColors(): Palette {
  return useTheme().colors;
}

export const radius = {
  card: 20,
  pill: 999,
  field: 14,
} as const;

/** L'unique ombre de l'app : posée sur tout ce qui flotte au-dessus de la carte. */
export const shadow = {
  elevation: 3,
  shadowColor: '#000000',
  shadowOpacity: 0.1,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
} as const;

/**
 * Boutons : une base + une taille + une variante, composées dans `style`. Tailles : `md` = 48 dp
 * (cible tactile minimale, D20 -- gants, moto), `lg` = 56 dp pour l'action principale.
 */
function buttonsFactory(c: Palette) {
  return StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    borderWidth: 1,
  },
  md: { minHeight: 48 },
  lg: { minHeight: 56 },
  primary: { backgroundColor: c.brand, borderColor: c.brand },
  secondary: { backgroundColor: c.surface, borderColor: c.border },
  brandSoft: { backgroundColor: c.brandSoft, borderColor: c.brandBorder },
  dangerSoft: { backgroundColor: c.dangerSoft, borderColor: c.dangerBorder },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  floating: { ...shadow },
});
}
const buttonsCache = new Map<ColorScheme, ReturnType<typeof buttonsFactory>>();
/** Pour composer dans `makeStyles((c) => ({ ...buttonsOf(c).x }))`. */
export function buttonsOf(c: Palette): ReturnType<typeof buttonsFactory> {
  let styles = buttonsCache.get(c.scheme);
  if (!styles) {
    styles = buttonsFactory(c);
    buttonsCache.set(c.scheme, styles);
  }
  return styles;
}
export function useButtons(): ReturnType<typeof buttonsFactory> {
  return buttonsOf(useColors());
}

function buttonLabelsFactory(c: Palette) {
  return StyleSheet.create({
  base: { fontSize: 16, fontWeight: '600' },
  lg: { fontSize: 17, fontWeight: '700' },
  primary: { color: c.onBrand },
  secondary: { color: c.ink },
  brand: { color: c.brandText },
  danger: { color: c.dangerText },
});
}
const buttonLabelsCache = new Map<ColorScheme, ReturnType<typeof buttonLabelsFactory>>();
/** Pour composer dans `makeStyles((c) => ({ ...buttonLabelsOf(c).x }))`. */
export function buttonLabelsOf(c: Palette): ReturnType<typeof buttonLabelsFactory> {
  let styles = buttonLabelsCache.get(c.scheme);
  if (!styles) {
    styles = buttonLabelsFactory(c);
    buttonLabelsCache.set(c.scheme, styles);
  }
  return styles;
}
export function useButtonLabels(): ReturnType<typeof buttonLabelsFactory> {
  return buttonLabelsOf(useColors());
}

/** Carte flottante au-dessus de la carte (proposition, course en cours). */
function cardsFactory(c: Palette) {
  return StyleSheet.create({
  floating: {
    borderRadius: radius.card,
    backgroundColor: c.surfaceGlass,
    ...shadow,
  },
});
}
const cardsCache = new Map<ColorScheme, ReturnType<typeof cardsFactory>>();
/** Pour composer dans `makeStyles((c) => ({ ...cardsOf(c).x }))`. */
export function cardsOf(c: Palette): ReturnType<typeof cardsFactory> {
  let styles = cardsCache.get(c.scheme);
  if (!styles) {
    styles = cardsFactory(c);
    cardsCache.set(c.scheme, styles);
  }
  return styles;
}
export function useCards(): ReturnType<typeof cardsFactory> {
  return cardsOf(useColors());
}
