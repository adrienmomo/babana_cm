# Rapport de nuit — J38

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-14.md`,
`services/odoo/addons/babana/models/babana_ride_invoice.py`,
`services/odoo/addons/babana/tests/test_invoice.py`,
`tools/config-coherence/scan.ts`, `tools/config-coherence/variables.ts`,
`infra/env/.env.example`, `infra/env/README.md`, `Makefile`,
`apps/client/config.ts`, `apps/client/config.web.ts`, `apps/driver/config.ts`,
`infra/production/deploy.sh`, `infra/production/lib/build-web-bundle.sh`.

Périmètre confié : L8-08 (sauvegardes et restauration, avec preuve exécutée), D60 (le bouton
d'envoi de facture ne commite plus la requête), D61 (les adresses de serveur sortent des replis
suffisants).

---

## 1. D60 — lever n'est pas une façon d'afficher

### Le défaut, tel qu'arbitré la nuit dernière

`button_send_invoice_email` faisait `env.cr.commit()` puis levait `UserError` sur échec.
`Cursor.commit()` exécute au passage tout point d'accroche au commit encore en attente sur ce
curseur (`env.cr.postcommit`, D32/D33) — un gestionnaire qui commite puis lève déclenche donc les
effets externes d'une requête qui se termine en erreur. Rien n'enregistrait de point d'accroche
avant ce bouton, mais la garantie tenait à ce fait précaire, pas à une propriété du code.

### Le correctif

Le gestionnaire ne lève plus. Sur échec, il renvoie une notification cliente
(`ir.actions.client` / `display_notification`, `type: danger`, `sticky: true`) portant le même
message que l'ancienne `UserError` — la transaction se termine normalement, l'écriture d'échec
(`babana_mail_error` sur la facture, via `_babana_attempt_invoice_email`) est dedans. Aucun
`env.cr.commit()` explicite n'est plus nécessaire : il n'y a plus rien à protéger d'un rollback
puisqu'il n'y a plus d'exception.

### Vérifié dans le vrai back-office (point 9)

Course C2026000347 (encaissée, facture envoyée) : email du client effacé par `odoo shell` pour
provoquer un échec réel, bouton « Envoyer / renvoyer la facture par email » cliqué. Notification
rouge affichée : « Envoi de la facture — Ce client n'a pas d'adresse email connue -- impossible
d'envoyer la facture. » — sans popup bloquant, sans page cassée. **Rechargement de la page** :
le ruban rouge « Échec d'envoi de la facture » était bien présent — l'écriture d'échec a survécu
au rechargement, la preuve visuelle que rien n'a été rejoué en arrière. Email restauré, bouton
recliqué en rattrapage : le ruban a disparu, `invoice_email_state` repassé à « Envoyée ». Course
laissée dans son état d'origine.

### Un défaut sans filet, maintenant couvert

Avant ce soir, le seul test qui passait par `button_send_invoice_email()` empruntait le chemin du
succès ; les deux tests d'échec existants appelaient `_babana_send_invoice_email()` directement,
jamais le bouton. Deux tests ajoutés à `test_invoice.py` :
- `test_button_on_failure_does_not_raise_and_returns_a_notification` — le bouton ne lève pas et
  renvoie bien `{'type': 'ir.actions.client', 'tag': 'display_notification', ...}` avec
  `type: 'danger'` et le message attendu ;
- `test_button_on_failure_leaves_the_failure_state_written` — après l'appel, l'état d'échec est
  bien lisible sur la course (`invoice_email_state == 'failed'`), sans qu'aucun `commit()`
  prématuré n'ait été nécessaire pour le faire survivre.

### Tests

Suite Odoo, module `babana`, tag `TestInvoice` : 19 tests, 0 échec, 0 erreur (les deux nouveaux
compris).

---

## 2. D61 — une adresse de production en repli sort du protocole des trois moments

### Le défaut

`BABANA_API_URL`/`BABANA_REALTIME_WS_URL` étaient dans `SELF_SUFFICIENT_DEFAULTS`
(`tools/config-coherence/variables.ts`), au motif que leur repli codé en dur
(`apps/client/config.ts`, `apps/driver/config.ts`) était « une adresse de production réelle ».
Vrai, et c'est ce qui posait problème : un binaire construit sans ces variables (un oubli sur
`make client`, un futur build de recette) parlait quand même à la vraie production, sans qu'aucun
contrôle ne le signale — D43 (« un repli plausible se croit, une absence se voit ») appliqué à une
adresse qu'on avait jugée inoffensive parce qu'elle était juste.

### Le correctif — même mécanisme que L0-10, étendu à deux variables de plus

Repris le protocole des trois moments (déclarée/livrée/consommée) déjà construit pour
`BABANA_MAPS_SEARCH_URL` :

- **Déclarée** vide dans `infra/env/.env.example`, sous l'exception D43 déjà documentée en tête
  du fichier (adresses de fournisseur externe, jamais de valeur ici).
- **Livrée** en développement par `make client` / `make driver` (Makefile, valeurs locales
  `https://api.localhost` / `wss://api.localhost/rt/ws`, motif `NAME="$(NAME)"` reconnu par
  `scanDeliveredByMakefile`) ; en production, le déploiement doit les poser lui-même.
- **Consommée** : inchangé, `apps/*/config.ts` (au build, `process.env.*`).

`apps/client/config.ts` et `apps/driver/config.ts` ne retombent plus sur
`'https://api.babana.cm'`/`'wss://api.babana.cm/rt/ws'` : une fonction `requireServerAddress`
lève à l'évaluation du module si la variable est absente — même discipline que
`getSearchUrl()`/`getGoogleMapsApiKey()` du paquet `@babana/maps` (D43). `apps/client/config.web.ts`
n'est **pas** concerné : son repli (`window.location.origin`) n'est pas une adresse de production
codée en dur, c'est l'origine courante (même origine que le bundle, D46) — la distinction, entre
un réglage qui peut avoir un repli réel et une destination qui ne le doit jamais, est celle que
D61 demande, et je l'ai écrite en commentaire dans `SELF_SUFFICIENT_DEFAULTS`.

`SELF_SUFFICIENT_DEFAULTS` retient désormais uniquement des RÉGLAGES (capture GPS, taille
d'upload) — jamais une DESTINATION — avec ce distinguo écrit en tête de liste pour que la
prochaine adresse n'y retourne pas par commodité.

**Portée volontairement restreinte à `apps/*/config.ts` (natif)**, pas au bundle web
(`infra/production/lib/build-web-bundle.sh`, `deploy.sh`) : `config.web.ts` n'a jamais eu ce
défaut (repli sûr, D46), y ajouter un garde-fou de build aurait été un changement sans motif
plutôt qu'une fermeture de D61 — et cela aurait cassé le test existant
`test/config/build-web-bundle.test.sh` sans raison métier. Étendre les mêmes garde-fous au bundle
web n'est donc pas fait ce soir : si une "recette" mobile automatisée voit le jour un jour, c'est
elle qui devra poser sa propre variable au build, comme `apps/client/config.ts` l'exige déjà.

### Corrigé au passage

`docs/operations/configuration.md` documentait encore `BABANA_API_URL` comme entrée de
`SELF_SUFFICIENT_DEFAULTS` avec repli `https://api.babana.cm` — n'était plus vrai après ce soir,
retiré, et une section D61 ajoutée à côté de celle de L0-10. `infra/env/README.md` (table des
variables + section "rien d'autre à renseigner") mis à jour avec les deux nouvelles lignes et la
même exception D43/D61 déjà rédigée pour `BABANA_MAPS_SEARCH_URL`.

### Tests

`test/config/config-coherence.test.ts` (6 tests, dépôt réel + preuves synthétiques des critères
2/3/4) : aucun maillon manquant. `test/config/build-web-bundle.test.sh` (3 scénarios, inchangé,
non affecté) : passe toujours. `npx tsc --noEmit` sur `apps/client` et `apps/driver` : propre —
`API_BASE_URL`/`REALTIME_WS_URL` restent typés `string`, aucun appelant à modifier. `npm run
lint -w @babana/client -w @babana/driver` : propre.

---
