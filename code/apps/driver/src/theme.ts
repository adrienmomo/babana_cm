import { StyleSheet } from 'react-native';

/**
 * Palette et formes de l'app Chauffeur -- un seul endroit, pour que chaque bouton et chaque carte
 * parlent la même langue visuelle : couleurs douces, boutons en pilule, une seule ombre.
 *
 * Règle d'usage : **l'action principale d'un moment est toujours `primary`** (vert plein) -- une
 * seule par écran ; tout le reste est `secondary` (blanc, bordure fine). Le rouge est réservé à
 * l'urgence et aux erreurs, en teinte douce (`dangerSoft`) plutôt qu'en aplat.
 */
export const colors = {
  brand: '#1A9E5C',
  brandPressed: '#15854D',
  brandSoft: '#E8F6EE',
  brandBorder: '#B8E2CB',
  brandText: '#137347',

  danger: '#E5484D',
  dangerSoft: '#FDEEEE',
  dangerBorder: '#F5C6C7',
  dangerText: '#C2363B',

  warningSoft: '#FFF6E3',
  warningBorder: '#F6DFAE',
  warningText: '#8A5A00',

  route: '#3E7BFA',

  ink: '#1F2937',
  inkSoft: '#374151',
  muted: '#6B7280',
  subtle: '#9CA3AF',
  border: '#E5E7EB',
  surface: '#FFFFFF',
  surfaceGlass: 'rgba(255, 255, 255, 0.96)',
  canvas: '#F7F8FA',
} as const;

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
export const buttons = StyleSheet.create({
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
  primary: { backgroundColor: colors.brand, borderColor: colors.brand },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  brandSoft: { backgroundColor: colors.brandSoft, borderColor: colors.brandBorder },
  dangerSoft: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  floating: { ...shadow },
});

export const buttonLabels = StyleSheet.create({
  base: { fontSize: 16, fontWeight: '600' },
  lg: { fontSize: 17, fontWeight: '700' },
  primary: { color: '#FFFFFF' },
  secondary: { color: colors.ink },
  brand: { color: colors.brandText },
  danger: { color: colors.dangerText },
});

/** Carte flottante au-dessus de la carte (proposition, course en cours). */
export const cards = StyleSheet.create({
  floating: {
    borderRadius: radius.card,
    backgroundColor: colors.surfaceGlass,
    ...shadow,
  },
});
