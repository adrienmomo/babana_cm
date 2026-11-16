import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { makeStyles } from '../theme';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import type { http } from '@babana/contracts';
import { fetchActivity, fetchCashSummary } from '../api/cash';
import { ActivityChart } from '../components/ActivityChart';
import { formatMoney } from '../format';
import type { DriverParamList } from '../navigation/types';

/**
 * Écran de recette (L5-07). **« Recette encaissée », jamais « revenus »** (É6) : un chauffeur
 * salarié (D5) n'a pas de gain variable par course, il détient l'argent de l'entreprise le temps
 * de le remettre. Le mot change ce que le chauffeur comprend de sa situation -- vérifié par un
 * test qui recherche « revenus », « gains », « salaire » et « bénéfice » dans les libellés
 * (critère 1).
 *
 * **La marge avant plafond est le chiffre qui compte** (brief de la nuit) : c'est lui qui dit au
 * chauffeur combien de courses il peut encore faire avant d'être bloqué. Affichée en premier
 * après le solde, avec un repère visuel de proximité -- même esprit que le bandeau de
 * `SettlementScreen.tsx` quand le plafond est déjà atteint, mais visible ici *avant* le blocage
 * (spécification : « l'approche du plafond est visible avant le blocage »).
 *
 * Toutes les données viennent de `GET /drivers/me/cash` à chaque affichage (critère 3) : `balance`,
 * `marginRemaining` et `collectedToday` sont ceux qu'Odoo a calculés, jamais recalculés ici -- y
 * compris l'indicateur de proximité, qui ne fait que colorer `marginRemaining`/`limit`, deux
 * valeurs déjà serveur, sans en dériver une troisième donnée financière.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Cash'>;

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  // `activity` null : son chargement a échoué -- la caisse s'affiche quand même, c'est elle qui
  // dit au chauffeur s'il peut continuer à travailler.
  | { status: 'loaded'; cash: http.DriverCashResponse; activity: http.DriverActivityResponse | null };

const STATUS_LABELS: Record<http.RemittanceHistoryEntry['status'], string> = {
  pending: 'En attente',
  validated: 'Validée',
  rejected: 'Contestée',
};

function proximityLevel(marginRemaining: number, limit: number): 'safe' | 'warning' | 'danger' {
  if (limit <= 0) return 'safe';
  const ratio = marginRemaining / limit;
  if (ratio <= 0.2) return 'danger';
  if (ratio <= 0.5) return 'warning';
  return 'safe';
}

function formatDeclaredAt(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function CashScreen({ navigation }: Props) {
  const styles = useStyles();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [cash, activity] = await Promise.all([fetchCashSummary(), fetchActivity().catch(() => null)]);
      setState({ status: 'loaded', cash, activity });
    } catch {
      // Réseau ou erreur serveur -- même écran d'erreur pour les deux, aucune distinction utile
      // au chauffeur ici (rien à réessayer différemment), contrairement à SettlementScreen où
      // l'écriture elle-même doit se rejouer.
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    load();
    // Rafraîchit au retour de l'écran de déclaration de remise (une remise fraîchement déclarée
    // doit apparaître dans l'historique sans que le chauffeur doive quitter puis rouvrir l'écran).
    const unsubscribe = navigation.addListener('focus', load);
    return unsubscribe;
  }, [navigation, load]);

  if (state.status === 'loading') {
    return (
      <View style={styles.container} testID="cash-screen">
        <Text testID="cash-loading">Chargement…</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.container} testID="cash-screen">
        <Text style={styles.error} testID="cash-error">
          Impossible de charger votre caisse pour le moment.
        </Text>
        <Button label="Réessayer" onPress={load} testID="cash-retry" />
      </View>
    );
  }

  const { cash, activity } = state;
  const level = proximityLevel(cash.marginRemaining, cash.limit);

  return (
    <ScrollView style={styles.container} testID="cash-screen" contentContainerStyle={styles.content}>
      {/* Le titre « Ma caisse » est déjà dans la barre de navigation : pas de second titre. */}
      <View style={styles.block}>
        <Text style={styles.label}>Recette encaissée aujourd’hui</Text>
        <Text style={styles.amount} testID="cash-collected-today">
          {formatMoney(cash.collectedToday)}
        </Text>
      </View>

      {activity ? (
        <ActivityChart activity={activity} />
      ) : (
        <Text style={styles.historyEmpty} testID="activity-unavailable">
          Activité indisponible pour le moment.
        </Text>
      )}

      <View style={styles.block}>
        <Text style={styles.label}>Solde à remettre</Text>
        <Text style={styles.amount} testID="cash-balance">
          {formatMoney(cash.balance)}
        </Text>
      </View>

      <View
        style={[styles.marginBlock, styles[MARGIN_LEVEL_STYLE_KEY[level]]]}
        testID="cash-margin-block"
      >
        <Text style={styles.label}>Marge avant plafond</Text>
        <Text style={styles.amount} testID="cash-margin-remaining">
          {formatMoney(cash.marginRemaining)}
        </Text>
        <Text style={styles.marginHint} testID="cash-limit">
          Plafond d’encaisse : {formatMoney(cash.limit)}
        </Text>
        {level !== 'safe' ? (
          <Text style={styles.marginWarning} testID="cash-margin-warning">
            {level === 'danger'
              ? 'Plafond proche : pensez à faire une remise avant de continuer.'
              : 'Le plafond approche.'}
          </Text>
        ) : null}
      </View>

      <Button
        label="Déclarer une remise"
        onPress={() => navigation.navigate('Remittance')}
        testID="cash-declare-remittance"
      />

      <View style={styles.historyBlock}>
        <Text style={styles.historyTitle}>Historique des remises</Text>
        {cash.remittances.length === 0 ? (
          <Text style={styles.historyEmpty} testID="cash-history-empty">
            Aucune remise déclarée pour le moment.
          </Text>
        ) : (
          cash.remittances.map((entry) => (
            <View key={entry.id} style={styles.historyRow} testID={`cash-history-row-${entry.id}`}>
              <Text style={styles.historyDate}>{formatDeclaredAt(entry.declaredAt)}</Text>
              <Text style={styles.historyAmount}>{formatMoney(entry.amount)}</Text>
              <Text style={styles.historyStatus} testID={`cash-history-status-${entry.id}`}>
                {STATUS_LABELS[entry.status]}
              </Text>
              <Text style={styles.historySupervisor}>
                {entry.supervisorName ?? 'Pas encore compté'}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  container: {
    flex: 1,
    backgroundColor: c.surface,
  },
  content: {
    padding: 24,
    gap: 20,
  },
  block: {
    gap: 4,
  },
  label: {
    color: c.muted,
    fontSize: 13,
  },
  amount: {
    fontSize: 28,
    fontWeight: '800',
    color: c.ink,
  },
  marginBlock: {
    gap: 4,
    padding: 14,
    borderRadius: 10,
  },
  marginSafe: {
    backgroundColor: c.brandSoft,
  },
  marginWarningLevel: {
    backgroundColor: c.warningSoft,
  },
  marginDanger: {
    backgroundColor: c.dangerSoft,
  },
  marginHint: {
    color: c.muted,
    fontSize: 12,
  },
  marginWarning: {
    color: c.dangerText,
    fontWeight: '600',
    marginTop: 4,
  },
  historyBlock: {
    gap: 10,
  },
  historyTitle: {
    color: c.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  historyEmpty: {
    color: c.muted,
  },
  historyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  historyDate: {
    color: c.inkSoft,
  },
  historyAmount: {
    fontWeight: '700',
    color: c.ink,
  },
  historyStatus: {
    color: c.inkSoft,
  },
  historySupervisor: {
    color: c.muted,
  },
  error: {
    color: c.dangerText,
  },
}));

const MARGIN_LEVEL_STYLE_KEY = {
  safe: 'marginSafe',
  warning: 'marginWarningLevel',
  danger: 'marginDanger',
} as const;
