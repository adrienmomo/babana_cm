# infra/production/monitoring — supervision externe (L0-07, étape 8)

**Règle non négociable : ces sondes tournent AILLEURS que sur l'hôte de production.** Une sonde
hébergée sur la machine qu'elle surveille se tait exactement au moment où elle serait utile
(amoa/04-monorepo-et-services.md §9). En pratique : une petite instance chez un autre
hébergeur, un runner de CI planifié, ou un service tiers (UptimeRobot, Better Stack, Uptime
Kuma auto-hébergé ailleurs).

## Deux scripts

| Script | Accès requis | Ce qu'il couvre |
|---|---|---|
| `probe.sh` | HTTP seul (aucun SSH) | Les trois hôtes répondent ; `/web/health` et `/rt/health` ; **expiration des certificats** |
| `probe-host.sh` | SSH vers l'hôte | **Occupation disque** ; **vol de CPU** (steal %, spécifique à D18/Contabo) ; **âge de la dernière sauvegarde** ; file d'attente Odoo (L3-12, *placeholder* — la file de rejeu n'existe pas encore) |

Les deux : une ligne `OK`/`ALERTE` par contrôle, code de sortie non nul s'il reste une alerte,
et appel de `ALERT_CMD` (avec le message en `$1`) par alerte — y brancher un webhook.

## Métriques de l'étape 8, et où elles sont

| Métrique (spécification) | Sonde | État |
|---|---|---|
| Disponibilité des trois hôtes | `probe.sh` | ✅ |
| Expiration des certificats | `probe.sh` | ✅ |
| Occupation disque | `probe-host.sh` | ✅ |
| Vol de CPU | `probe-host.sh` | ✅ |
| Réussite de la dernière sauvegarde | `probe-host.sh` (lit `.state/last_backup_ok`) | ✅ |
| Taille de la file d'attente vers Odoo (L3-12) | `probe-host.sh` | ⏳ en attente de L3-12 |

## Vérifier que l'alerte fonctionne vraiment

Le critère de fin de la mise en production (§9) : **provoquer volontairement une panne** et
constater l'alerte. Par exemple `docker compose -f infra/compose.yaml stop realtime` sur l'hôte,
attendre le prochain passage de `probe.sh`, vérifier que `ALERT_CMD` s'est déclenché, redémarrer.
Tant que ce test n'a pas eu lieu, la supervision est « installée » mais pas « prouvée ».

## Exemple de planification (crontab de la machine de supervision)

```cron
*/2 * * * *  DOMAIN=babana.cm      ALERT_CMD='curl -s -X POST "$WEBHOOK" --data-urlencode "text=$1"'  sh /opt/babana-mon/probe.sh
*/5 * * * *  SSH_TARGET=deploy@babana.cm  ALERT_CMD='curl -s -X POST "$WEBHOOK" --data-urlencode "text=$1"'  sh /opt/babana-mon/probe-host.sh
```
