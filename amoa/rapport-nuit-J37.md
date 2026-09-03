# Rapport de nuit — J37

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-13.md`, `amoa/01-architecture.md` §9 sexies,
`amoa/specs/L0-socle.md` (L0-10), `amoa/specs/L4-course.md` (L4-05/L4-06, D57/D58),
`infra/production/deploy.sh`, `infra/env/.env.example`, `infra/env/README.md`,
`services/odoo/addons/babana/models/babana_ride_invoice.py`,
`services/odoo/addons/babana/models/babana_ride_state.py`,
`services/odoo/addons/babana/services/push.py`,
`services/odoo/addons/babana/tests/test_realtime_commit_hook.py`.

Périmètre confié : L0-10 (cohérence de la chaîne de configuration), D57 (facture automatique et
visibilité de l'échec), le test instable de `test_realtime_commit_hook.py`.

---

## 1. L0-10 — la cohérence des trois moments, mécanique plutôt que relue

### Le mécanisme

`code/tools/config-coherence/` recense, pour chaque variable rencontrée (déclarée dans
`infra/env/.env.example`, ou simplement trouvée dans le code), ses trois moments — déclarée,
livrée, consommée — et signale tout maillon manquant, dans les deux sens. `test/config/
config-coherence.test.ts` l'exécute contre le vrai dépôt (doit rester vide) et, séparément,
contre des mini-dépôts synthétiques (`mkdtemp`) qui prouvent chaque famille de défaut sans
modifier puis annuler le vrai dépôt à chaque passage — critères d'acceptation 2, 3 et 4 de
L0-10, chacun avec sa preuve.

**Portée délibérément restreinte.** Un scan qui suivrait toute variable lue par ce dépôt aurait
fait échouer la suite sur des dizaines de réglages métier légitimes (`services/realtime/src/
config.ts` en porte plus de trente, `apps/driver/config.ts` une douzaine) qui ont un repli réel
et dont l'absence ne casse rien — ce n'est pas le défaut du 13 septembre. `tools/config-
coherence/variables.ts` documente explicitement ce qui est hors du protocole
(`INTERNAL_TOPOLOGY_NAMES`, `SELF_SUFFICIENT_DEFAULTS`) et ce qui est un vrai maillon manquant
assumé (`EXCEPTIONS`, chacune avec sa tâche de fermeture).

**Une exception de la spécification s'est révélée fausse en la vérifiant.** `amoa/specs/
L0-socle.md` donnait « FCM_* sans fournisseur » comme exemple d'exception attendue. Vérifié dans
le dépôt avant de la recopier dans `variables.ts` (CLAUDE.md : une dépendance supposée absente se
vérifie dans le dépôt) : `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY` sont déjà
déclarées, livrées (`infra/compose.yaml`) et consommées (`services/push.py::FcmPushProvider`,
avec ses tests) — les trois moments tiennent, aucune exception à poser. Écart consigné dans
`amoa/questions/L0-10.md`, sur `master`.

### Le défaut du 13 septembre, fermé

`infra/production/deploy.sh` faisait `. infra/env/.env` puis `npm run build:web -w
@babana/client` directement : un `. fichier` en shell pose des variables de SHELL, jamais
transmises à un processus fils sans `export`. Preuve dans le dépôt ce matin-là,
`apps/client/dist-web/bundle.js` : `MAPS_SEARCH_URL = false||undefined`.

Deux garde-fous, pas un seul :

1. `deploy.sh` exporte désormais tout ce que `.env` déclare (`set -a`/`set +a` autour du
   sourcing) — un filet mécanique contre toute variable de build future qu'on oublierait
   d'exporter une par une.
2. `infra/production/lib/build-web-bundle.sh` (`build_web_bundle`), isolé pour rester testable
   sans docker ni dépôt git réel, exporte explicitement les trois variables de build juste avant
   `npm`, **puis grep le fichier produit** (`apps/client/dist-web/bundle.js`) pour la valeur
   réelle de chacune — le contrôle porte sur le bundle produit (critère 6), pas sur les variables
   d'environnement.

`deploy.sh` échoue désormais si l'une des trois (`BABANA_MAPS_SEARCH_URL`,
`BABANA_GOOGLE_WEB_CLIENT_ID`, `BABANA_GOOGLE_MAPS_API_KEY`) est vide ou pointe vers une valeur
de développement — il n'avertit plus (D43 étendu à la chaîne de build).

**Critère 7** : `test/config/build-web-bundle.test.sh` reproduit le défaut à l'identique — les
trois variables posées comme variables de shell, jamais exportées, contre un faux `npm` qui se
comporte comme le vrai plugin Babel (absente de son environnement → `undefined`) — vérifie que le
bundle produit est cassé, puis rejoue le même scénario à travers `build_web_bundle` et vérifie
qu'il est correct. C'est la preuve que ce test échoue sur le `deploy.sh` d'avant cette tâche.

**Corrigé au passage** : `infra/env/README.md` affirmait que `.env` « n'a pas d'équivalent en
production » et que le déploiement injecte les variables directement dans le conteneur — faux
depuis L0-07, `deploy.sh` lit bien `infra/env/.env` sur le serveur. Corrigé, avec renvoi vers
`docs/operations/configuration.md`.

### Tests

`test/config/config-coherence.test.ts` (6, dépôt réel + preuves synthétiques des critères 2/3/4).
`test/config/build-web-bundle.test.sh` (3 scénarios, exécuté par `make test`) : le défaut
reproduit et corrigé, l'échec avant tout appel npm si une variable est vide.

---

## 2. D57 — la facture part seule, et un échec se voit

### Ce qui change

`babana_ride_state.py::action_settle` enregistre désormais l'envoi automatique de la facture au
COMMIT (`_babana_settle_send_invoice_email_async`), jamais depuis le savepoint qui vient de la
générer — même distinction que D58 a posée pour l'inverse : la facture (`account.move`) est une
écriture PostgreSQL ordinaire, défaite par un `ROLLBACK`, donc elle reste dans le savepoint ;
l'email, lui, est un appel SMTP sortant qu'un `ROLLBACK` ne peut pas défaire. Fil de fond +
nouveau curseur, même patron que `services/push.py::notify_users_async` (mêmes raisons : latence
SMTP qui ne doit jamais retarder la réponse d'encaissement, écriture ORM après un commit qui
exige un curseur neuf).

Le bouton manuel reste, comme rattrapage, et partage désormais le même chemin
(`_babana_attempt_invoice_email`) que l'envoi automatique — pas de logique dupliquée, pas de
statut qui diverge selon qui a déclenché l'envoi.

### La visibilité, condition non négociable de D57

`babana.ride.invoice_email_state`/`invoice_email_failure_reason` sont des champs **calculés,
jamais stockés** : `babana_ride_state.py::write` interdit toute écriture sur une course `settled`,
sans exception, y compris pour un administrateur (invariant 2) — et l'envoi automatique n'a de
sens qu'après l'encaissement. Le compte rendu est donc déposé sur la FACTURE
(`account.move.babana_mail_id`/`babana_mail_error`, deux nouveaux champs), et la course le lit à
travers `invoice_id` : aucune écriture sur la course, donc aucun conflit avec l'invariant.

`mail.sudo().send()` n'échoue pas par exception — Odoo l'avale et pose `state='exception'` +
`failure_reason` en silence, exactement le mécanisme qui a caché la panne SMTP totale du 13
septembre (D59). Le succès de l'appel Python ne suffit donc jamais : il faut relire `mail.state`
après coup.

Visible là où un superviseur regarde déjà (`babana_ride_views.xml`, « Suivi des courses », déjà
l'outil de travail du superviseur, L9-03) : un badge rouge/vert dans la liste
(`decoration-danger`), un ruban rouge sur le formulaire, le motif de l'échec affiché en clair, et
un filtre de recherche (« Échec d'envoi de la facture ») dont le domaine porte sur les champs
STOCKÉS de la facture — le champ calculé de la course, lui, n'est pas filtrable côté serveur.

### Un vrai défaut trouvé en ouvrant l'écran (définition de fini, point 9)

Provoqué un échec réel (client sans adresse email, back-office ouvert, bouton cliqué) : le popup
d'erreur s'affichait — mais après rechargement, `invoice_email_state` était resté à sa valeur
d'avant le clic. Cause : `button_send_invoice_email` écrivait `babana_mail_error` **puis** levait
`UserError` — Odoo annule la transaction entière d'un appel RPC dès qu'une exception s'en échappe,
donc l'écriture partait avec elle. Corrigé par un `env.cr.commit()` explicite avant de lever, sans
quoi ce test n'aurait jamais vu que l'écran mentait. Reproduit et corrigé le même soir, entièrement
grâce au point 9 — aucun test automatisé n'aurait attrapé ça, puisque les tests appellent
`_babana_attempt_invoice_email` directement, jamais à travers le rollback RPC réel du bouton.

**Un second défaut, trouvé de la même façon.** `make seed` peuplait 8 courses réglées sans qu'une
seule facture ne parte : `odoo shell` (utilisé par `services/odoo/scripts/seed.py`) se termine par
`os._exit(0)`, qui tue net tout fil démon encore en vol — et un fil lancé par `env.cr.postcommit`
peut mettre **plus de trente secondes** à obtenir du temps CPU sous `workers = 0` juste après une
suite de tests qui vient de solliciter le même processus (vérifié : même un échec de précondition
sans rendu PDF ni appel réseau a pris ce temps). `seed.py` attend désormais, de façon bornée (120 s,
en interrogeant l'état réel de chaque facture, jamais un délai fixe) que chaque envoi automatique
ait abouti avant de laisser le script se terminer. Les 8 courses déjà semées avant ce correctif ont
été rattrapées manuellement (`_babana_attempt_invoice_email`, le même chemin que le bouton).
Documenté dans `docs/odoo-pitfalls.md`.

### Vérifié dans le vrai back-office (point 9)

Connecté en `admin`, ouvert « Suivi des courses », vu le badge vert « Envoyée » sur une course
semée (facture BINV/2026/00011, envoi réel confirmé par Mailpit pendant la suite de tests de la
nuit — 23 emails « Votre facture babana.cm -- ... » livrés). Provoqué un échec réel (adresse
email effacée temporairement sur un client de démonstration, restaurée ensuite) : ruban rouge
« Échec d'envoi de la facture » sur le formulaire, badge rouge « Échec d'envoi », motif affiché en
clair (« Ce client n'a pas d'adresse email connue -- impossible d'envoyer la facture. »). Laissé
volontairement dans cet état sur la course C2026000355 : le jeu de démonstration montre ainsi les
trois états (`sent` sur la majorité, `failed` sur celle-ci) sans qu'une prochaine nuit ait besoin
de reprovoquer un échec pour voir à quoi il ressemble.

### Tests

`test_invoice.py` (+7) : enregistrement automatique au commit (même patron que
`test_push.py::test_notify_users_async_only_schedules_a_postcommit_hook`), résilience du fil de
fond (même patron que `test_the_background_send_swallows_every_failure`), et trois preuves de
visibilité qui PROVOQUENT l'échec (SMTP simulé en panne, adresse manquante) plutôt que de
vérifier qu'un envoi réussi réussit — critère d'acceptation 7, la question du soir de J36.

---
