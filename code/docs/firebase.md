# Notifications push — Firebase (15 novembre)

## Ce qui est en place

| Qui | Quand | Contenu (jamais de donnée sensible : écran verrouillé) |
|---|---|---|
| Chauffeur | nouvelle proposition | « Nouvelle course proposée » — ouvre la proposition (L7-04) |
| Client | chauffeur affecté | « Un chauffeur arrive » |
| Client | chauffeur arrivé (« Sur place ») | « Votre chauffeur est arrivé » |
| Client | course terminée | « Course terminée » |

Envoyées par Odoo après le commit, sur un fil de fond (`services/push.py`, `notify_users_async`) :
un envoi lent ou raté ne touche jamais une transition. Android les affiche app fermée ou en
arrière-plan ; app à l'écran, l'écran le dit déjà. Côté chauffeur, une proposition reçue par
Firebase app fermée **sonne** (`src/push/firebase.ts` → `ringtone.ts`).

Le jeton d'appareil est enregistré à chaque session établie (`registerDeviceToken`) et désactivé à
la déconnexion volontaire (`@babana/api-client`, `push/`).

## Projet Firebase

- Projet Google Cloud / Firebase : **`babana-cm`** (créé le 15 novembre).
- Applications Android : `cm.babana.driver` et `cm.babana.client`.
- Compte de service d'envoi : `babana-fcm@babana-cm.iam.gserviceaccount.com`, rôle
  `roles/firebasecloudmessaging.admin`.

## Configuration

**Apps** — `apps/{driver,client}/android/app/google-services.json`, **jamais versionnés** :

```bash
make firebase-config   # gcloud connecté à un compte qui voit le projet babana-cm
```

Sans ces fichiers, les apps se construisent et tournent quand même (le plugin Gradle n'est
appliqué que s'ils existent) : pas de jeton, pas de push — le WebSocket reste le canal principal.

**Serveur** — `infra/env/.env` (jamais versionné) :

```
PUSH_PROVIDER=fcm            # 'console' : envois journalisés seulement (défaut, tests)
FCM_PROJECT_ID=babana-cm
FCM_CLIENT_EMAIL=babana-fcm@babana-cm.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…"
```

La clé se crée par `gcloud iam service-accounts keys create` (compte ci-dessus) et ne se copie
que dans `.env`. Sur la pile de développement, **laisser `PUSH_PROVIDER=console`** pour `make
test` : les tests Odoo du module push (`tests/test_push.py`) lisent les envois simulés. Passer à
`fcm` le temps d'un essai réel, puis revenir à `console`.

## Limites connues

- iOS : rien n'est configuré (pas d'app iOS Firebase, pas d'APNs).
- La sonnerie en boucle et le retour au premier plan sont Android seulement.
