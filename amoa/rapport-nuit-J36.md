# Rapport de nuit — J36

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md` (le point 9 de la
définition de fini), `amoa/questions/REPONSES-2026-09-12.md`, `amoa/specs/L3-temps-reel.md`
(L3-12, L3-17, L3-11), `amoa/specs/L4-course.md` (L4-05, L4-06), `amoa/questions/L3-17.md`,
`amoa/questions/L4-05.md`, `amoa/01-architecture.md` §2 et §7,
`services/realtime/src/odoo/{client,rides}.ts`, `services/realtime/src/proposal/lifecycle.ts`,
`services/odoo/addons/babana/controllers/{ride,internal}.py`,
`services/odoo/addons/babana/models/{babana_ride,babana_ride_state,babana_cash_remittance}.py`,
`services/odoo/addons/babana/__init__.py`, `apps/client/src/components/fareBreakdown.ts`.

Périmètre confié : L3-12 (file de rejeu côté service temps réel) et L4-06 (facture).

---

## 1. L3-12 — la file de rejeu, et une spécification qui ne décrivait plus le dépôt

### Vérifié avant d'écrire une ligne : « quatre appels » n'en fait plus que deux

La spécification énumère quatre écritures Odoo dont le service temps réel porterait les appels
2 et 3 (affectation, fin de course). En ouvrant `controllers/ride.py::_complete_ride` avant de
supposer quoi que ce soit : la fin de course est déclenchée par l'app chauffeur **directement**
sur Odoo, qui **lit** le relevé de trajet accumulé (`fetch_ride_measurement`, l'exception déjà
documentée pour `reserve_and_propose`) avant sa propre transition — jamais un appel sortant que
ce service initierait. Seul l'appel 2 (affectation/refus) est réellement porté par
`odoo/rides.ts`. Consigné dans `amoa/questions/L3-12.md`, avec la correction proposée pour la
spécification — je ne l'ai pas corrigée moi-même, le protocole réserve ça à une demande
explicite.

Conséquence retenue : `OUTBOX_ENTRY_TYPES` (`odoo/outbox.ts`) énumère exactement
`driver-accepted`/`driver-rejected`, et `enqueueOutboxEntry` refuse à l'exécution tout type hors
de cette liste — la lecture la plus proche du critère 1 de L3-12 (« un test échoue si un
cinquième type apparaît ») compatible avec ce que le dépôt fait réellement.

### Le trou lui-même : un refus qui échouait durablement bloquait la course pour toujours

Constaté depuis le 20 août (`amoa/questions/L3-17.md`) : `reportDriverAccepted`/
`reportDriverRejected` appelaient `callOdoo` directement — trois réessais **en mémoire**, perdus
si le service redémarre. Un refus dont l'appel Odoo échouait plus longtemps que ces trois
réessais laissait la course bloquée en `proposed` pour toujours (`action_propose` n'accepte que
`requested`/`rejected` en état source).

`odoo/outbox.ts` : chaque entrée est posée dans Redis (`babana:outbox:queue`, `babana:outbox:
entry:*`) **avant** toute tentative HTTP — c'est ce qui la fait survivre à un redémarrage, le
passage périodique suivant trouve simplement une échéance déjà dépassée. `reportOutboxWrite`
persiste puis tente un envoi immédiat sans bloquer l'appelant (même contrat que l'ancien code) :
latence inchangée dans le cas courant, filet réel dans le cas dégradé. Délai croissant plafonné
(`OUTBOX_BASE_DELAY_MS`/`OUTBOX_MAX_DELAY_MS`), alerte journalisée si la file dépasse un seuil ou
qu'une entrée dépasse son nombre de tentatives (`OUTBOX_ALERT_*`) — même principe que
`driver/reconcile.ts` (répare **et** dénonce), cinq nouveaux paramètres, aucun codé en dur.

### L'idempotence : un rappel à moi-même autant qu'aux prochaines nuits

La spécification (« Odoo rejette silencieusement un identifiant déjà traité ») demandait le
mécanisme d'idempotence par en-tête `Idempotency-Key` déjà posé pour les routes publiques (L4-03,
`_common.run_idempotent`) — jamais câblé sur `controllers/internal.py`, qui ne comptait jusqu'ici
que sur `action_accept`/`action_reject` échouant proprement en `RIDE_INVALID_TRANSITION` sur un
état déjà transitionné. **Écrit dans l'écart avant d'être réellement fait** : une relecture avant
de committer a trouvé que `internal.py` n'avait pas bougé alors que `amoa/questions/L3-12.md`
l'affirmait déjà — corrigé sur-le-champ, avant tout commit, mais le noter ici parce que c'est
exactement le genre d'écart entre le dit et le fait que ce dépôt existe pour traquer. `_dispatch`
enveloppe désormais le handler dans `run_idempotent` ; sans en-tête (aucun appelant hors la file
aujourd'hui), rien ne change. Trois tests dans `test_internal_controller.py` le prouvent : un
rejeu avec la même clé renvoie la réponse mise en cache sans réexécuter la transition, un rejeu
sans clé garde l'ancien filet 409.

### Tests

`test/outbox.test.ts` (13, Redis réel + faux serveur Odoo local, même patron que
`reconcile.test.ts`) : persistance avant tentative, délai croissant (mesuré depuis l'instant de
chaque appel, pas depuis un total cumulé — la première version comparait des durées polluées par
la variance d'un aller-retour localhost et échouait au hasard), Idempotency-Key stable à travers
le rejeu, reprise après « redémarrage » simulé (aucune référence en mémoire conservée), 409
`RIDE_INVALID_TRANSITION` traité comme déjà appliqué, alertes de seuil. `test_internal_
controller.py` (+3, ci-dessus).

---

## 2. L4-06 — la facture, et trois vérifications qui ont chacune trouvé quelque chose

### L'écart le plus important de la nuit : où poser la pièce

La consigne demandait de poser la facture au commit, jamais depuis un savepoint (D32/D33) — le
patron des appels sortants vers le service temps réel. Avant de l'appliquer telle quelle : D32/D33
gouvernent un aller-retour HTTP qui modifie Redis, une donnée qu'une transaction Odoo annulée ne
peut pas défaire (en-tête de `realtime_client.py`) — pas une écriture PostgreSQL ordinaire dans
la même transaction. Deux sources internes disaient le contraire de la consigne : `amoa/
questions/L4-05.md` (« L4-06 rejoint le même savepoint qu'action_settle »), et
`babana_cash_remittance.py::_babana_post_accounting_entry`, déjà en production, qui pose la pièce
comptable de la remise de caisse **à l'intérieur** du même genre de savepoint. Suivi ce
précédent plutôt que la formulation littérale de la consigne — détaillé dans
`amoa/questions/L4-06.md`, avec la raison : sortir la facture du savepoint aurait recréé
exactement « une course encaissée sans facture » si sa pose échouait après que l'encaissement a
déjà commité, le défaut que cette tâche existe pour fermer.

Piège découvert en l'implémentant : `babana_ride_state.py::write` interdit toute écriture sur une
course déjà `settled`, y compris depuis l'intérieur du même savepoint qui vient de l'y faire
passer — `_babana_generate_invoice()` doit donc s'exécuter **avant** `_babana_write_transition`,
et `invoice_id` voyage dans le même appel que `state`/`settled_at`, jamais un second `write()`.

### Le détail décomposé : une seule définition, pas deux qui auraient pu diverger

`apps/client/src/components/fareBreakdown.ts` (FARE_LINES/visibleFareLines) porte déjà les
libellés et la règle de visibilité (prise en charge et distance toujours affichées, le reste
seulement si non nul). Rejoué à l'identique côté facture (`_FARE_LINES`, `babana_ride_invoice.py`)
plutôt que réinventé — une facture qui nommerait les composantes autrement que l'écran déjà
montré au client serait illisible en cas de contestation.

**Dégradation plutôt que blocage** : une course créée hors du vrai flux `/quote -> /rides`
(aujourd'hui uniquement en test) n'a pas de `fare_rule_snapshot`. Bloquer l'encaissement pour ça
aurait été pire que l'absence de décomposition — même raisonnement que `action_complete`/
`notify_ride_completed` (D30), étendu de l'affichage à la disponibilité de l'encaissement
lui-même : une facture à une seule ligne (« Course », le montant final) plutôt qu'aucune facture.

### Le gabarit : un test qui a trouvé une vraie erreur de rendu

`t-field` posé directement sur des `<td>` (départ, arrivée, chauffeur, immatriculation, lignes du
détail) — Odoo refuse ce placement (« QWeb widgets do not work correctly on 'td' elements »),
trouvé par `test_report_html_contains_every_required_mention` avant d'atteindre un navigateur.
Chaque `t-field` enveloppé d'un `<span>`. Le test du PDF réel (`_render_qweb_pdf`) échouait aussi
au premier passage pour une raison différente : Odoo bascule silencieusement en HTML sous
`--test-enable` pour accélérer la suite (`force_report_rendering` absent du contexte) — le test
force maintenant ce contexte, exactement pour prouver ce qu'il prétend prouver.

### Le point 9 : un écran ouvert, et un troisième défaut trouvé en le regardant vraiment

Connecté en `admin`, ouvert une course encaissée du jeu de seed, cliqué jusqu'à la facture
(`BINV/2026/00027`, Nadège Eloundou, Bonabéri (démo) → Akwa (démo), 7,2 km, Guy Njoya, LT 2288
CF, détail Prise en charge/Distance/Majoration/Arrondi sommant à 1 425 FCFA). PDF réel généré
(`%PDF`, vérifié par zoom sur le rendu). Puis cliqué sur « Envoyer la facture par email » (le
bouton du formulaire, `header`, visible seulement si une facture existe) : rien ne s'est affiché
côté écran, mais Mailpit était vide — l'email n'était pas parti. `mail.mail.failure_reason` :
« Connection refused », et le même échec touchait un email **antérieur à cette nuit** (« Security
Update: Password Changed », posé à l'installation) : l'envoi de courrier n'a jamais fonctionné
dans cet environnement.

`SMTP_HOST`/`PORT`/`USER`/`PASSWORD`/`FROM` sont documentées et posées sur le conteneur depuis
plusieurs nuits (`infra/compose.yaml`, `infra/env/README.md` : « pour l'envoi de facture » —
donc en anticipation explicite de cette tâche), `infra/production/deploy.sh` refuse même de
partir sans un vrai relais — mais rien, nulle part dans le dépôt, ne les traduisait en
`ir.mail_server`. `mail.mail.send()` tombait sur le repli d'Odoo (connexion locale, port 25) et
échouait en silence, la panne n'étant visible que dans un champ que personne n'a de raison
d'ouvrir. Même défaut que celui déjà consigné pour `ADMIN_PASSWORD` le 11 septembre — une
variable documentée, jamais branchée — trouvé cette fois avant le pilote plutôt qu'après, parce
que cette nuit est la première à avoir réellement essayé d'envoyer un email.

`_post_init_mail_server` (nouveau, chaîné dans `_post_init_hook` après D53) pose `ir.mail_server`
depuis ces variables — sans lever si `SMTP_HOST` est absent, à la différence d'`ADMIN_PASSWORD`
(D43, sans repli) : `.env.example` le laisse vide exprès, `deploy.sh` est déjà le garde-fou qui
empêche un déploiement de production sans relais réel. Piège immédiat : `smtp_authentication`
n'accepte pas `'none'` en Odoo 18 (`login`/`certificate`/`cli`/`gmail` seulement) — `'login'`
avec `smtp_user` vide fonctionne pour Mailpit, qui n'authentifie pas. `test_smtp_server.py` (+2)
prouve le câblage et l'absence de blocage sans hôte.

Réessayé après correction : le bouton envoie, Mailpit reçoit « Votre facture babana.cm --
C2026000345 », pièce jointe PDF de 35 kB, et les deux emails de sécurité déjà cassés
(invitation, changement de mot de passe) partent désormais aussi — effet de bord bienvenu, pas
cherché.

### Tests

`test_invoice.py` (13) : facture postée et numérotée, lignes correspondant à la décomposition
visible et sommant exactement au montant final, plancher masqué à zéro, journal/compte
paramétrables, atomicité si le journal n'est pas configuré (rien n'est appliqué), montant gelé
même si la grille tarifaire change ensuite (`new_version()`, la règle ne se modifie jamais en
place une fois utilisée), dégradation à une ligne, mentions du gabarit, PDF réel, aucun envoi
automatique à l'encaissement, envoi rejeté sans facture ou sans email client, envoi réel avec
pièce jointe. `test_smtp_server.py` (+2, ci-dessus). `test_currency_required.py` étendu aux deux
nouveaux paramètres comptables (journal et compte de facturation).

---

## Non-régression

`make reset && make up && make seed`, puis `make test` en entier, répété plusieurs fois pour
isoler un test instable rencontré deux fois (ci-dessous) : suite Odoo **2 577 tests, 0 échec, 0
erreur** sur base fraîche ; `services/realtime` 226 tests ; les autres paquets/apps 79 + 37.
`make seed` idempotent, 29 courses réglées dont 29 facturées.

**Un test instable trouvé, non corrigé, signalé** : `test_realtime_commit_hook.py`, deux tests
différents selon l'exécution (`test_notify_cancellation_async_touches_no_redis_key_if_the_
transaction_rolls_back`, puis `test_clear_engagement_does_nothing_if_the_transaction_rolls_
back`) ont chacun échoué une fois sur plusieurs passages complets, toujours réussi en répétant.
Les deux dépendent d'un `time.sleep(1.0)` après un rollback simulé (`_FakeEnv`) pour laisser le
temps à un éventuel appel mal programmé de partir — sensible à la charge de la machine au moment
du passage, pas au contenu de la course. Aucun rapport avec les changements de cette nuit :
ni L3-12 ni L4-06 ne touchent `notify_cancellation_async`/`clear_engagement`, et le fichier
n'apparaît dans aucun diff d'aujourd'hui. Signalé plutôt que réparé à l'aveugle, même politique
que J35.

---

## Ce qui laisse un doute pour quelqu'un de réel

**La facture n'a été vue qu'en français, jamais en anglais ni dans une langue que porterait un
vrai profil client.** `apps/client/src/components/fareBreakdown.ts` fixe les libellés en dur, le
gabarit d'impression aussi (« Prise en charge », « Distance »...) — cohérent entre les deux, mais
aucun des deux ne passe par le mécanisme de traduction Odoo. Si un jour la facture doit exister
en anglais (client étranger, chauffeur d'une agence partenaire), les deux fichiers divergeront à
traduire séparément, et personne n'aura de raison de s'en souvenir avant ce jour-là.

**Le compte de produit et le journal de facturation portent des valeurs par défaut plausibles,
jamais validées par un comptable** — même réserve que celle déjà écrite pour les comptes de la
remise de caisse (D21, `05-prerequis-et-simulation.md` §5) : numérotation « classe 7 » indicative,
generic_coa plutôt que OHADA. Une facture réelle, envoyée à un vrai client, porterait ces
libellés provisoires tels quels si le pilote démarrait avant cette validation.

**Et la question du soir** : le bouton d'envoi n'affiche aucune confirmation ni aucune erreur à
l'écran — un superviseur qui clique dessus n'a que le silence pour savoir si ça a marché,
exactement le défaut que l'ancien câblage SMTP cachait ce soir. Fonctionnel maintenant, mais si un
vrai relais de production tombe en panne un jour, le même silence reviendra, et cette fois sans
personne qui teste dans les dix minutes qui suivent.
