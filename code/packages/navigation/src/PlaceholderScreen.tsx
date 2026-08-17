import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface PlaceholderScreenProps {
  title: string;
  /** Identifiant de la tâche qui remplacera cet écran, ex. "L6-06". */
  task: string;
}

/**
 * Écran-pont : même discipline que les champs-pont de CLAUDE.md ("tracés, datés, condamnés"),
 * appliquée à un écran plutôt qu'à un champ de modèle. Les quinze écrans métier des lots L6-05 à
 * L6-17 n'existent pas encore ce soir, mais l'arborescence qui les accueillera doit exister
 * (critère d'acceptation 1 de L6-00) -- chaque route non encore écrite pointe ici plutôt que de
 * ne pas exister du tout, avec le nom de la tâche qui la remplacera. Traçable par recherche de
 * `PlaceholderScreen`, pas découvert par accident en production : la tâche qui écrit l'écran
 * réel retire l'usage de `PlaceholderScreen` qui la nomme, même geste que pour un champ-pont.
 */
export function PlaceholderScreen({ title, task }: PlaceholderScreenProps) {
  return (
    <View style={styles.container} testID="placeholder-screen">
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.task}>Écran à venir -- {task}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  task: {
    fontSize: 14,
    color: '#666666',
  },
});
