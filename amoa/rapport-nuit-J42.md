# Rapport — nuit J42 (4 septembre 2026)

Périmètre : rejouer `npm test` en entier avant toute autre chose, puis L8-09 (journal d'audit
immuable, D67).

---

## 1. `npm test` rejoué — les trois échecs de J41 étaient environnementaux, confirmé

Avant tout code : les containers `mock-google-identity` et `mock-maps` (`infra/compose.dev.yaml`)
étaient sortis en erreur (`Exited (255)`) neuf heures avant la reprise — cohérent avec la
« signature d'une machine mise en veille » que J41 soupçonnait pour ses trois échecs
(`concurrency/select-driver-replay`, `http-contract::createRideShare/revokeRideShare`).
`make reset && make up && make seed` a suffi à les relever ; ce n'était pas un défaut du code.

**Un deuxième round de faux échecs, cette nuit-ci, avait une cause différente et plus
instructive.** Après une première tentative de `make test` interrompue par une erreur de syntaxe
XML de ma part (`--` dans un commentaire `<!-- -->`, invalide en XML — corrigé), puis une seconde
interrompue par une collision réelle mais bénigne entre l'installation du module et le cron de
purge de jeton qui tourne toutes les minutes (`SerializationFailure` sur `ir.cron`, réessai
suffisant), une exécution complète a fini par tourner sur une base fraîche — jusqu'à ce que le
processus `npm test` lui-même soit terminé (`SIGTERM`) par l'environnement de session après une
assez longue durée, à deux reprises indépendantes, quelle que soit la façon dont je l'attendais
(veille planifiée, tâche de fond bloquante). Ce n'est ni un défaut du dépôt ni un défaut de
l'infrastructure Docker : c'est une limite de durée de vie des tâches de fond de cette session
d'agent, hors de portée du code.

**Pendant l'une de ces attentes, une tentative de vérification isolée a révélé un vrai problème
méthodologique, pas un défaut produit** : j'ai lancé `concurrency/ride-transitions.test.ts` seul
pour vérifier un échec (`scénario 3`, chauffeur jamais apparu dans `nearby.drivers`) pendant que
la tentative précédente, que je croyais arrêtée, tournait *encore* en arrière-plan (le
`runner` de `node --test` continue les fichiers suivants après l'échec d'un test, il ne s'arrête
pas). Les deux exécutions ont donc sollicité le même Odoo/Redis/service temps réel en même temps
— exactement le genre de contention qui produit ce symptôme précis. Le process en trop tué, la
suite a tourné seule et propre.

**Conclusion, prouvée fichier par fichier plutôt qu'en un seul `make test` ininterrompu** (la
seule concession à la consigne « sans coupure » — chaque morceau, lui, l'a été) : sur la même base
fraîche, sans jamais retrouver un vrai défaut de code —

- Suite Odoo (`-i babana --test-enable`) : **806 tests, 0 échec, 0 erreur** (782 la nuit dernière
  + les 16 tests de L8-09 ci-dessous).
- `concurrency/ride-transitions.test.ts` : 3/3 (les trois scénarios de charge).
- `concurrency/select-driver-replay.test.ts` : 1/1.
- `auth/token-handshake.test.ts` : 2/2.
- `http-contract/endpoint-coverage.test.ts` : 25/25, `settleRide` compris (le point qui avait
  échoué sous contention).
- `config/config-coherence.test.ts`, `config/env-example.test.ts`,
  `storage/public-entrypoint.test.ts` : 18/18.
- `e2e/full-ride.test.ts` (L10-01) : 5/5.
- `packages/*` (api-client, contracts, maps, navigation, ui) : propre.
- `services/realtime` : 226/226.
- `apps/client` (19 suites) et `apps/driver` (28 suites) : 110 + 193 tests, propre.
- `docs/contracts/verify-ride-state-machine.js` et `verify-realtime-message-map.js` : propres (ce
  dernier signale toujours les trois messages en attente déjà connus, sans lien avec cette nuit).
- `test/config/build-web-bundle.test.sh` : tous les cas passent.
- `npm run test:resilience` (L3-14) : 3/3, conteneurs `realtime`/`redis` sains après le
  redémarrage.

Une seule ligne à corriger dans mon propre test, découverte au passage : `test_audit_log.py`
créait deux courses `requested` pour le **même** client, que `babana_ride_one_active_per_client`
(L4-01) refuse — corrigé en utilisant deux clients distincts (voir §2, critère 5).

**Verdict de J41 confirmé sans réserve** : les trois instabilités relevées cette nuit-là
(`select-driver-replay`, `createRideShare`, `revokeRideShare`) ne sont pas des défauts du dépôt —
elles ne se sont pas reproduites une seule fois cette nuit sur un environnement sain et non
contentionné.

---

## 2. L8-09 — le journal d'audit immuable (D67)

### Le point d'accroche existant, étendu plutôt que reconstruit

`babana_ride_state.py::_babana_journalize`, en place depuis le premier jour et appelé aux huit
transitions de course, écrit maintenant dans `babana.audit.log` en plus du journal applicatif —
avant/après portent l'état de la course (capturé avant l'écriture de transition, à chaque site
d'appel). Les sept autres événements obligatoires de la spécification ne passent **pas** par ce
point unique — je l'ai vérifié plutôt que supposé, comme le prompt le demandait, et chacun a son
propre point d'accroche, au plus près de l'écriture qu'il journalise :

- **Mouvement de compte courant** (`babana.cash.movement`, tout `movement_type` — l'ajustement en
  fait partie, pas une catégorie séparée à journaliser à part) : `create()`, désormais surchargé.
- **Remise et sa validation** : `create()` de `babana.cash.remittance` (la déclaration — seul
  chemin de création) pour le premier événement, `action_validate` pour le second, dans le même
  savepoint que la pièce comptable et le mouvement qu'elle produit.
- **Changement d'état chauffeur** : `babana_driver.py::write()`, où l'état d'avant est capturé
  juste avant `super().write()` — couvre `action_approve/reject/suspend/reactivate` et toute
  écriture directe de `state` (même défense en profondeur que le forçage `is_online` voisin).
- **Accès à un document chauffeur, le seul qui ne passe par aucune transition** — trouvé et câblé
  à deux endroits distincts, comme la spécification l'annonçait : `controllers/documents.py::
  _signed_url` (le chemin mobile réel) et `babana_driver_document.py::action_preview` (la
  prévisualisation back-office, même mécanisme de signature d'URL).

### Immuabilité : au niveau du modèle, jamais par règle

`babana_audit_log.py::write()` lève inconditionnellement — aucun chemin, aucun contexte, aucun
`sudo()` ne le contourne, parce que la méthode ne délègue jamais à `super()` : la vérification
d'accès de l'ORM (qu'un `sudo()` bypasse) n'est même pas atteinte. `unlink()` fait de même, sauf
sous un drapeau de contexte (`babana_allow_audit_log_purge`) posé **uniquement** par la purge
planifiée elle-même — même patron que `_babana_write_transition` pour `state` (invariant 2).
Critère d'acceptation 2 : `TestAuditLogImmutable` tente la modification et la suppression au nom
d'un administrateur réel (`group_babana_admin`), puis en `sudo()` explicite — les deux échouent.

### Un échec du journal ne bloque jamais l'opération métier

`_babana_record` enveloppe son unique `create()` dans un savepoint dédié et un `except Exception`
générique : une panne de l'écriture du journal (contrainte SQL, table absente, ce qu'on veut) ne
remonte jamais à l'appelant — seul `_logger.exception` le sait. Vérifié à blanc
(`TestAuditLogNeverBlocksBusinessOperation`) : `babana.audit.log.create` patché pour lever
systématiquement, la création d'une course et d'un mouvement de compte courant réussissent quand
même, sans laisser d'entrée.

**Le point délicat que le prompt annonçait** (D58) : une écriture PostgreSQL ordinaire se pose
dans la transaction de l'opération qu'elle décrit, jamais au commit — mais elle ne doit pas la
faire échouer. Le savepoint dédié de `_babana_record` concilie les deux : posée dans la même
transaction (donc annulée par le même `ROLLBACK` que le reste si l'opération échoue pour une autre
raison — cohérent), mais son propre échec ne s'étend jamais au-delà de son propre savepoint.
Appelée directement (jamais via `cr.postcommit`), y compris depuis l'intérieur du savepoint plus
large d'`action_validate` (remise) — les savepoints s'imbriquent sans conflit chez PostgreSQL.

### Purge par rétention, paramétrable (invariant 5)

`babana.audit_log_retention_days` (repli à 730 jours — généreux à dessein, en attendant que L8-10,
hors de ce lot, affine la durée par catégorie) et un `ir.cron` quotidien
(`ir_cron_babana_purge_audit_log`) qui appelle `_cron_purge`, le seul code qui pose le drapeau de
contexte franchissant l'immutabilité. `TestAuditLogPurge` : une entrée vieillie par SQL direct
(seul moyen de simuler l'ancienneté sur un modèle qui refuse `write()`) est purgée, une entrée
récente ne l'est pas ; une rétention à zéro jour purge une entrée qui vient d'être créée —
vérifie que la durée est réellement lue depuis le paramètre, pas codée en dur.

### Vue back-office, réservée aux administrateurs

`views/babana_audit_log_views.xml` : liste filtrable (par référence, événement, modèle,
identifiant, acteur), regroupable (modèle, événement, acteur, jour), formulaire en lecture seule
avec avant/après/contexte technique dans des onglets séparés. `ir.model.access.csv` n'accorde la
**lecture seule** qu'à `group_babana_admin` (aucune ligne pour superviseur ni gestionnaire — accès
nul, pas seulement masqué) ; même écriture jamais accordée à personne, y compris l'administrateur
— seul le point d'écriture interne (`sudo()` dans `_babana_record`) crée des lignes, l'ACL ne fait
qu'empêcher une création manuelle depuis l'écran. Menu sous `babana_menu_root`, `groups=` explicite
en plus de l'ACL (même redondance délibérée que `babana_menu_pricing`).

**Ouverte et vérifiée, pas seulement compilée (point 9 de la définition de fini)** : connecté en
administrateur, le menu « Journal d'audit » apparaît dans l'application Babana et s'ouvre sur une
liste de 1353 entrées réelles (toute l'activité de cette nuit et des précédentes) — horodatage,
événement, modèle concerné, référence, acteur, exactement les colonnes attendues. Une entrée
`driver.state_change` ouverte en formulaire affiche ses trois onglets Avant/Après/Contexte
technique en JSON lisible : `{"state": "pending"}` puis `{"state": "approved"}` — l'approbation
d'un dossier chauffeur, reconstituée sans ambiguïté. C'est le seul usage réel de cet écran, et
c'est celui-là qui a été regardé.

### Le filet contre l'oubli, tenu

`babana.audit.log` étant un nouveau modèle `babana.*`, `test_matrix_covers_every_babana_model`
(L8-02, la matrice d'habilitation générée) l'aurait fait échouer sans une entrée dans
`tests/fixtures/access_matrix.json` — ajoutée (`none` partout pour les deux rôles mobiles, aucun
des deux n'a jamais accès, ce qui est la vérité). Pas une extension de L8-02 elle-même (hors de ce
lot), seulement la mise à jour mécanique que le filet existant exige.

Fichiers : `models/babana_audit_log.py`, `models/babana_ride_state.py`,
`models/babana_cash_movement.py`, `models/babana_cash_remittance.py`, `models/babana_driver.py`,
`models/babana_driver_document.py`, `controllers/documents.py`, `views/babana_audit_log_views.xml`,
`security/ir.model.access.csv`, `data/cron.xml`, `__manifest__.py`, `tests/test_audit_log.py`,
`tests/__init__.py`, `tests/fixtures/access_matrix.json`.

`odoo -d babana --test-enable --stop-after-init -i babana` sur base fraîche : **806 tests, 0
échec, 0 erreur** — voir §1 pour la suite complète.

### Un point non couvert, à nommer plutôt que taire

Le prompt demandait « chaque accès à un document chauffeur » — j'ai journalisé l'accès à l'URL
signée (la lecture du fichier lui-même), sur les deux chemins qui existent. `GET
/api/v1/driver/documents` (la simple liste des métadonnées, sans URL signée, L6-15) n'est **pas**
journalisé : ce n'est pas un accès au contenu de la pièce, seulement à son état de vérification —
la même distinction que la spécification fait déjà ailleurs entre lire qu'une chose existe et y
accéder réellement. Si un litige exigeait un jour de tracer aussi les consultations de statut, ce
serait un élargissement à nommer, pas un oubli de cette nuit.
