import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Le ⋮ de l'écran de profil, en haut à droite : aujourd'hui une seule entrée, « Se déconnecter »,
 * confirmée avant de partir -- une déconnexion par mégarde coûte une nouvelle vérification par
 * SMS. La confirmation est dans le menu lui-même, pas dans `Alert.alert`, qui ne fait rien dans
 * l'export web (D22).
 */
export interface AccountMenuProps {
  appName: string;
  /** Déconnecte. Rend un message à afficher si la déconnexion n'a pas eu lieu (refus du serveur),
   * rien sinon -- la garde d'authentification démonte alors l'écran. */
  onSignOut: () => Promise<string | null | void>;
}

type MenuState = { open: false } | { open: true; confirming: boolean; busy: boolean; error: string | null };

export function AccountMenu({ appName, onSignOut }: AccountMenuProps) {
  const [menu, setMenu] = useState<MenuState>({ open: false });

  function close() {
    if (menu.open && menu.busy) return;
    setMenu({ open: false });
  }

  async function confirmSignOut() {
    setMenu({ open: true, confirming: true, busy: true, error: null });
    let error: string | null = null;
    try {
      error = (await onSignOut()) ?? null;
    } catch {
      error = 'La déconnexion a échoué. Réessayez.';
    }
    // Déconnecté : l'écran (et ce menu) est démonté par la garde d'authentification.
    if (error) setMenu({ open: true, confirming: true, busy: false, error });
  }

  return (
    <>
      <Pressable
        testID="account-menu-button"
        accessibilityRole="button"
        accessibilityLabel="Plus d’options"
        hitSlop={8}
        onPress={() => setMenu({ open: true, confirming: false, busy: false, error: null })}
        style={({ pressed }) => [styles.kebab, pressed ? styles.pressed : null]}
      >
        <View style={styles.dot} />
        <View style={styles.dot} />
        <View style={styles.dot} />
      </Pressable>

      <Modal visible={menu.open} transparent animationType="fade" onRequestClose={close}>
        <Pressable testID="account-menu-backdrop" style={styles.backdrop} onPress={close}>
          {menu.open ? (
            // Un appui dans la carte ne doit pas refermer le menu.
            <Pressable style={styles.card} onPress={() => undefined}>
              {menu.confirming ? (
                <View style={styles.confirm}>
                  <Text style={styles.question}>{`Se déconnecter de ${appName} ?`}</Text>
                  {menu.error ? (
                    <Text testID="account-menu-error" style={styles.error}>
                      {menu.error}
                    </Text>
                  ) : null}
                  <View style={styles.actions}>
                    <Pressable
                      testID="account-menu-confirm-sign-out"
                      accessibilityRole="button"
                      disabled={menu.busy}
                      onPress={confirmSignOut}
                      style={[styles.action, styles.actionDanger]}
                    >
                      {menu.busy ? (
                        <ActivityIndicator color="#C2363B" />
                      ) : (
                        <Text style={styles.actionDangerLabel}>Se déconnecter</Text>
                      )}
                    </Pressable>
                    <Pressable
                      testID="account-menu-cancel"
                      accessibilityRole="button"
                      disabled={menu.busy}
                      onPress={() => setMenu({ open: false })}
                      style={[styles.action, styles.actionSecondary]}
                    >
                      <Text style={styles.actionSecondaryLabel}>Annuler</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  testID="account-menu-sign-out"
                  accessibilityRole="button"
                  onPress={() => setMenu({ open: true, confirming: true, busy: false, error: null })}
                  style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.itemDanger}>Se déconnecter</Text>
                </Pressable>
              )}
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  kebab: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#1F2937',
  },
  pressed: {
    opacity: 0.6,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    alignItems: 'flex-end',
    paddingTop: 56,
    paddingHorizontal: 12,
  },
  card: {
    width: 280,
    maxWidth: '100%',
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    paddingVertical: 4,
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  item: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  itemDanger: {
    color: '#C2363B',
    fontSize: 16,
    fontWeight: '600',
  },
  confirm: {
    padding: 16,
    gap: 12,
  },
  question: {
    color: '#1F2937',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#C2363B',
  },
  // Empilés pleine largeur : côte à côte, « Se déconnecter » se coupait en deux lignes.
  actions: {
    gap: 8,
  },
  action: {
    minHeight: 48,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionSecondary: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
  },
  actionSecondaryLabel: {
    color: '#1F2937',
    fontWeight: '600',
  },
  actionDanger: {
    backgroundColor: '#FDEEEE',
    borderColor: '#F5C6C7',
  },
  actionDangerLabel: {
    color: '#C2363B',
    fontWeight: '600',
  },
});
