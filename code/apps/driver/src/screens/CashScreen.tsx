import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@babana/ui';
import type { http } from '@babana/contracts';
import { fetchCashSummary } from '../api/cash';
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
  | { status: 'loaded'; cash: http.DriverCashResponse };

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
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const cash = await fetchCashSummary();
      setState({ status: 'loaded', cash });
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

  const { cash } = state;
  const level = proximityLevel(cash.marginRemaining, cash.limit);

  return (
    <ScrollView style={styles.container} testID="cash-screen" contentContainerStyle={styles.content}>
      <Text style={styles.title}>Ma caisse</Text>

      <View style={styles.block}>
        <Text style={styles.label}>Recette encaissée aujourd’hui</Text>
        <Text style={styles.amount} testID="cash-collected-today">
          {formatMoney(cash.collectedToday)}
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.label}>Solde à remettre</Text>
        <Text style={styles.amount} testID="cash-balance">
          {formatMoney(cash.balance)}
        </Text>
      </View>

      <View
        style={[styles.marginBlock, MARGIN_LEVEL_STYLE[level]]}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 24,
    gap: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  block: {
    gap: 4,
  },
  label: {
    color: '#6B7280',
    fontSize: 13,
  },
  amount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#111827',
  },
  marginBlock: {
    gap: 4,
    padding: 14,
    borderRadius: 10,
  },
  marginSafe: {
    backgroundColor: '#ECFDF5',
  },
  marginWarningLevel: {
    backgroundColor: '#FFFBEB',
  },
  marginDanger: {
    backgroundColor: '#FEF2F2',
  },
  marginHint: {
    color: '#6B7280',
    fontSize: 12,
  },
  marginWarning: {
    color: '#B91C1C',
    fontWeight: '600',
    marginTop: 4,
  },
  historyBlock: {
    gap: 10,
  },
  historyTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  historyEmpty: {
    color: '#6B7280',
  },
  historyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  historyDate: {
    color: '#374151',
  },
  historyAmount: {
    fontWeight: '700',
    color: '#111827',
  },
  historyStatus: {
    color: '#374151',
  },
  historySupervisor: {
    color: '#6B7280',
  },
  error: {
    color: '#B91C1C',
  },
});

const MARGIN_LEVEL_STYLE: Record<'safe' | 'warning' | 'danger', object> = {
  safe: styles.marginSafe,
  warning: styles.marginWarningLevel,
  danger: styles.marginDanger,
};
