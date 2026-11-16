import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { makeStyles } from './theme';

/**
 * Pastille de profil : la photo du compte Google quand elle charge, sinon les initiales, sinon une
 * silhouette. Une photo qui ne charge pas (hors connexion, adresse expirée) retombe sur les
 * initiales plutôt que de laisser un rond vide. Primitives `react-native` seulement (D22).
 */
export interface AvatarProps {
  name: string;
  photoUrl: string | null;
  /** Diamètre en dp. */
  size: number;
  /** Les initiales portent `${testID}-initials`. */
  testID?: string;
}

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase('fr-FR'))
    .join('');
}

export function Avatar({ name, photoUrl, size, testID }: AvatarProps) {
  const styles = useStyles();
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => setPhotoFailed(false), [photoUrl]);

  const circle = { width: size, height: size, borderRadius: size / 2 };
  const initials = initialsOf(name);

  if (photoUrl && !photoFailed) {
    return (
      <Image
        testID={testID}
        source={{ uri: photoUrl }}
        onError={() => setPhotoFailed(true)}
        style={[styles.base, circle]}
        accessibilityIgnoresInvertColors
      />
    );
  }

  return (
    <View testID={testID} style={[styles.base, styles.fallback, circle]}>
      {initials ? (
        <Text testID={testID ? `${testID}-initials` : undefined} style={[styles.initials, { fontSize: size * 0.38 }]}>
          {initials}
        </Text>
      ) : (
        // Silhouette : une tête, des épaules -- sans bibliothèque d'icônes.
        <View style={styles.silhouette}>
          <View style={[styles.head, { width: size * 0.34, height: size * 0.34, borderRadius: size * 0.17 }]} />
          <View style={[styles.shoulders, { width: size * 0.6, height: size * 0.26, borderTopLeftRadius: size * 0.3, borderTopRightRadius: size * 0.3 }]} />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  base: {
    overflow: 'hidden',
    backgroundColor: c.brandSoft,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.brandBorder,
  },
  initials: {
    color: c.brandText,
    fontWeight: '700',
  },
  silhouette: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: '20%',
  },
  head: {
    backgroundColor: c.brand,
  },
  shoulders: {
    backgroundColor: c.brand,
  },
}));
