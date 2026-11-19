import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { http } from '@babana/contracts';
import { apiClient, authClient } from '../auth';
import { PriorityBar, newDriverPointsLocked } from '../components/PriorityBar';
import { formatLocalDay } from '../format';
import { makeStyles } from '../theme';
import type { DriverParamList } from '../navigation/types';

/**
 * « Ma priorité » (19 novembre) : ouverte depuis la carte et depuis le profil. Le total, la barre
 * par sorte de points, puis le détail de chacune -- valeurs et maximums tels que le serveur les
 * envoie (`driverPriority` de `GET /me`), relus à l'ouverture. « Courses acceptées » ouvre le
 * journal des points, « Note des clients » le calcul des points de note.
 */
type Props = NativeStackScreenProps<DriverParamList, 'Priority'>;

type Detail = { key: string; title: string; value: string; text: string; locked?: boolean; target?: 'RidePoints' | 'StarPoints' };

export function PriorityScreen({ navigation }: Props) {
  const styles = useStyles();
  const [priority, setPriority] = useState<http.DriverPriority | undefined>(() => authClient.getUser()?.driverPriority);

  useEffect(() => {
    let cancelled = false;
    authClient.refreshUser(apiClient).then(
      (state) => {
        if (!cancelled && state.user?.driverPriority) setPriority(state.user.driverPriority);
      },
      () => undefined // hors connexion : celle de la session reste affichée
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!priority) {
    return (
      <View style={[styles.container, styles.empty]} testID="priority-unavailable">
        <Text style={styles.muted}>Votre priorité n'est pas disponible pour le moment.</Text>
      </View>
    );
  }

  const locked = newDriverPointsLocked(priority);
  const allDetails: Detail[] = [
    {
      key: 'rides',
      title: 'Courses acceptées',
      value: `${priority.ridePoints} / ${priority.ridePointsMax}`,
      text: 'Une proposition laissée sans réponse fait perdre des points. Chaque course terminée en rend.',
      target: 'RidePoints',
    },
    {
      key: 'stars',
      title: 'Note des clients',
      value: `${priority.starPoints} / ${priority.starPointsMax}`,
      text: 'Une bonne note moyenne de vos clients vous rapporte des points.',
      target: 'StarPoints',
    },
    {
      key: 'new',
      title: 'Nouveau chauffeur',
      value: `${priority.newDriverPoints} / ${priority.newDriverPointsMax}`,
      text: locked
        ? 'Période de bienvenue terminée : ces points sont verrouillés.'
        : priority.newDriverUntil
          ? `Bonus de bienvenue jusqu'au ${formatLocalDay(priority.newDriverUntil)}.`
          : 'Bonus de bienvenue.',
      locked,
    },
  ];
  const details = allDetails.filter((detail) => detail.key !== 'new' || priority.newDriverPointsMax > 0);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="priority-screen">
      <View style={styles.card}>
        <Text style={styles.caption}>Votre priorité</Text>
        <Text testID="priority-total" style={styles.total}>
          {priority.total}
          <Text style={styles.totalMax}> / {priority.max} points</Text>
        </Text>
        <PriorityBar priority={priority} />
        <Text style={styles.muted}>
          À proximité d'un client, la course est proposée d'abord au chauffeur qui a le plus de points.
        </Text>
      </View>

      {details.map((detail) => {
        const target = detail.target;
        return (
          <Pressable
            key={detail.key}
            testID={`priority-detail-${detail.key}`}
            accessibilityRole={target ? 'button' : undefined}
            disabled={!target}
            onPress={target ? () => navigation.navigate(target) : undefined}
            style={({ pressed }) => [styles.card, detail.locked ? styles.lockedCard : null, pressed ? styles.pressed : null]}
          >
            <View style={styles.detailHeader}>
              <Text style={[styles.detailTitle, detail.locked ? styles.lockedText : null]}>
                {detail.locked ? '🔒 ' : ''}
                {detail.title}
              </Text>
              <View style={styles.detailEnd}>
                <Text style={[styles.detailValue, detail.locked ? styles.lockedText : null]}>{detail.value}</Text>
                {target ? <Text style={styles.chevron}>›</Text> : null}
              </View>
            </View>
            <Text style={styles.muted}>{detail.text}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.canvas },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    gap: 10,
  },
  lockedCard: { backgroundColor: c.surfaceMuted },
  caption: { color: c.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  total: { color: c.ink, fontSize: 40, fontWeight: '800' },
  totalMax: { color: c.muted, fontSize: 18, fontWeight: '600' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  detailTitle: { color: c.ink, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  detailValue: { color: c.ink, fontSize: 17, fontWeight: '700' },
  lockedText: { color: c.muted },
  pressed: { opacity: 0.7 },
  detailEnd: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chevron: { color: c.subtle, fontSize: 24 },
  muted: { color: c.muted, fontSize: 14, lineHeight: 20 },
}));
