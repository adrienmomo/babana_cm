# Rapport — nuit J43 (4 septembre 2026)

Périmètre : D68 (l'échec du journal d'audit doit se voir ailleurs que dans le journal,
`amoa/01-architecture.md` §9 decies).

---

## 1. D68 — un signal qui ne vit pas dans ce qu'il surveille

Le raisonnement du prompt était juste et je n'ai rien eu à y ajouter : le critère 3 (le journal
ne lève jamais) et le critère 2 (personne ne peut y écrire à sa place) composent, ensemble, un
silence — un échec d'écriture n'avait plus d'autre trace que `_logger.exception`, c'est-à-dire le
journal applicatif que L8-09 existe pour remplacer.

**Le support choisi : `ir.config_parameter`, jamais `babana.audit.log`.** Un compteur logé dans
le modèle qui vient de casser casserait avec lui — c'est la contrainte que le prompt posait, et
c'est elle qui élimine la plupart des solutions naturelles (un modèle métrique dédié aurait le
même problème que `babana.audit.log` lui-même : une table Postgres de plus, pas d'un autre ordre).
`ir.config_parameter` est déjà le mécanisme que ce module utilise pour toute valeur paramétrable
(invariant 5) — l'emprunter ici n'ajoute rien de nouveau à comprendre.

`babana_audit_log.py::_babana_record_failure_beacon` (nouvelle méthode, appelée depuis le
`except` existant de `_babana_record`) pose cinq paramètres — compteur, horodatage, événement,
modèle, message d'erreur tronqué à 500 caractères — dans un savepoint qui lui est propre, avec la
même garde que `_babana_record` : elle ne lève jamais, y compris si cette écriture-ci échoue à son
tour (un `except Exception` supplémentaire, qui se contente de `_logger.exception`). Deux niveaux
de défense, symétriques.

**Un choix qui n'était pas dans le prompt : le signal ne s'efface pas tout seul.** Un échec
intermittent qui redevient vert au prochain événement resterait invisible pour un administrateur
qui ouvre l'écran après coup, si la prochaine écriture réussie remettait le compteur à zéro. Le
signal reste donc posé jusqu'à un geste explicite — un bouton « Marquer comme vu »
(`action_acknowledge`) qui efface les cinq paramètres — plutôt que jusqu'au prochain succès. Testé
directement : un événement journalisé avec succès entre un échec et sa consultation ne doit rien
effacer (`test_acknowledge_clears_the_signal_but_only_on_an_explicit_gesture`).

**L'écran : `babana.audit.log.health`, un `TransientModel` non stocké**, même patron que
`babana.cash.dashboard` (L9-05) — `default_get()` relit les cinq paramètres à chaque ouverture.
Formulaire avec bandeau rouge (`alert-danger`) si un échec est signalé, vert (`alert-success`)
sinon, détails (compteur, horodatage, événement, modèle, erreur) visibles seulement dans le
premier cas, bouton d'accusé de réception réservé à `group_babana_admin`. Menu « État du journal
d'audit » posé juste avant « Journal d'audit » dans le même menu, réservé au même groupe (ACL
admin, `1,1,1,1` — le formulaire s'ouvre par un `create({})`, comme le tableau de bord de caisse).

**Test qui provoque l'échec, pas qui vérifie un succès** (comme demandé) :
`TestAuditLogFailureVisibility`, quatre tests, tous construits sur le montage existant de
`TestAuditLogNeverBlocksBusinessOperation` (`patch.object(AuditLogModel, "create", side_effect=
RuntimeError(...))`) :
- le signal devient visible sur `babana.audit.log.health` sans qu'aucun test n'ouvre un fichier de
  logs (`test_write_failure_becomes_visible_without_opening_a_log_file`) ;
- il survit alors même que le modèle qui casse est celui qui aurait dû le porter — deux pannes
  successives, le compteur les accumule (`test_signal_survives_even_though_the_model_that_failed_
  cannot_carry_it`) ;
- un succès entre-temps n'efface rien, seul l'accusé de réception le fait
  (`test_acknowledge_clears_the_signal_but_only_on_an_explicit_gesture`).

Filet contre l'oubli (L8-02) : `babana.audit.log.health` ajouté à
`tests/fixtures/access_matrix.json` (`none` pour les deux rôles mobiles, comme
`babana.cash.dashboard` — aucun accès mobile n'a de sens pour un écran de supervision interne).

---

## 2. Un vrai défaut trouvé en construisant le signal, pas un défaut hypothétique

En vérifiant le mécanisme à blanc (suite complète, base fraîche — §3), un des 819 tests a produit
une ERREUR de journalisation **réelle**, non provoquée par un `patch` :
`test_upload_and_fetch_signed_url_round_trip` (`test_documents.py`), qui appelle la vraie route
`GET /api/v1/driver/documents/<id>/url`.

**La cause : `_URL_ROUTE` portait `readonly=True`.** `code/docs/odoo-pitfalls.md` documente déjà
la règle depuis L1-01 (15 août) : une route `auth='none'` est montée en lecture seule par défaut
depuis Odoo 18, et toute route qui écrit doit poser `readonly=False` explicite. Cette route-là
avait raison de porter `readonly=True` **au moment où elle a été écrite** — elle ne lisait alors
vraiment que la base. Puis L8-09 (nuit J42) a ajouté, à l'intérieur de `_signed_url`, l'écriture de
l'entrée d'audit « chaque accès à un document chauffeur » (le seul événement de la spécification
sans transition) — sans revenir sur le `readonly` de la route qui la porte.

**Conséquence, en production comme dans ce test : l'écriture échouait à chaque appel réel**,
silencieusement absorbée par le savepoint de `_babana_record` (critère 3 — exactement ce qui rend
le silence possible). Le test de critère 1 de L8-09
(`test_audit_log.py::test_driver_document_access_produces_an_entry`) ne l'avait pas trouvé parce
qu'il exerçait le même point d'écriture par le chemin back-office (`action_preview`), jamais par
cette route HTTP — la limite que le rapport de J42 nommait déjà lui-même honnêtement (« ici via le
chemin back-office, le plus simple à exercer sans HTTP »). **L'événement que la spécification
appelle « le seul sans transition » n'a donc jamais été réellement journalisé par le chemin réel,
depuis sa création la nuit dernière, jusqu'à cette nuit.**

C'est exactement le silence contre lequel D68 a été écrite — trouvé en la construisant, pas le
jour d'un litige. Je le prends comme une validation du signal plus que comme un défaut isolé :
sans lui, cette ERREUR serait restée dans `_logger.exception`, invisible, indéfiniment.

**Corrigé** : `_URL_ROUTE` porte maintenant `readonly=False` (`controllers/documents.py`), avec un
commentaire qui explique pourquoi et renvoie vers ce défaut. Je n'ai pas ouvert d'écart
(`amoa/questions/`) — la règle à appliquer est déjà écrite noir sur blanc dans le dépôt depuis
L1-01, ce n'est pas un point d'arbitrage, c'est un oubli mécanique. `code/docs/odoo-pitfalls.md`
reçoit un corollaire : la règle protège une route déclarée en écrivant dès le départ, pas une
route dont le corps change plus tard — quiconque ajoute une écriture dans une route existante doit
relire son `readonly` déclaré, ne jamais le supposer déjà correct.

**Preuve, par la vraie route, pas par un appel Python direct** :
`test_signed_url_access_is_journalized_over_a_real_http_call` (nouveau, `test_documents.py`) —
upload puis `GET .../url` en HTTP réel, assertion sur l'entrée d'audit produite ET sur
`babana.audit.log.health.has_failure` (faux, pour prouver que cette route-là ne casse plus).

---

## 3. `npm test` non rejoué cette nuit — le périmètre était la suite Odoo, base vraiment fraîche

Contrairement aux nuits précédentes, `make reset` a été poussé jusqu'au bout ce soir : volume
Postgres entièrement effacé, pas seulement les conteneurs de simulation relevés. Deux
conséquences, une attendue et une qui ne l'était pas.

**Attendue : un premier `-i babana --test-enable` sur un volume vraiment vide réinstalle TOUS les
modules dont `babana` dépend pour la première fois** (`account`, `mail`, `hr`...), et
`--test-enable` fait alors tourner leurs propres suites — des milliers de tests Odoo amont, sans
rapport avec ce dépôt, pour un temps d'exécution qui dépasse largement ce qu'une nuit peut
absorber. Rien à corriger ici : ce n'est pas notre code. J'ai scindé l'opération en deux passes
(`-i babana` seul d'abord, sans `--test-enable`, pour installer une fois ; puis
`-i babana --test-enable` — idempotent sur un module déjà installé, comme `make seed` le documente
déjà) pour obtenir un schéma et des données réellement neufs sans repayer le coût des suites Odoo
amont à chaque invocation. Les nuits précédentes qui rapportaient « 806 tests » sur une base dite
fraîche n'avaient probablement jamais traversé un volume Postgres vraiment vide en une seule
séquence — sinon ce coût aurait été visible dans leurs journaux. À noter pour la prochaine
personne qui fait un `make reset` complet : la première passe d'installation prend plusieurs
minutes de plus qu'un `make reset` habituel ne le laisse deviner.

**Pas attendue : la suite `TestRemittanceAccounting` échouait de façon parfaitement reproductible
sur l'ancienne base** (montée il y a plusieurs heures, jamais réinitialisée cette nuit-là) —
`test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance`,
45850.0 au lieu de 45000, à chaque exécution, isolée ou non. Vérifié sur le contenu de `master`
avant tout changement de cette nuit (git stash) : même échec, identique au centime près — ce
n'est donc pas un défaut introduit ce soir. **Sur la base vraiment fraîche de ce soir, ce test
passe, comme les 818 autres.** C'est la même famille que le piège déjà documenté (« cent
vingt-sept tests verts sur une base ancienne », `code/docs/odoo-pitfalls.md`) mais dans l'autre
sens — un échec d'artefact plutôt qu'un succès d'artefact. Je n'ai pas cherché plus loin quel
paramètre avait dérivé sur cette base précise (probablement `babana.cash_limit` ou un compte
d'écart altéré par une session antérieure qui aurait committé directement plutôt que par une
transaction de test) : le lot L5 est sous vigilance particulière (`CLAUDE.md`) et n'était pas le
périmètre de cette nuit. Je le nomme plutôt que de le laisser dormir : si ce delta de 850
réapparaît sur une base qui a servi plusieurs nuits sans `make reset`, ce n'est pas d'emblée un
défaut du code de remise — vérifier d'abord sur une base neuve avant de rouvrir le lot L5.

**Résultat, base fraîche, suite Odoo complète (`babana` et toutes ses dépendances déjà
installées)** : `odoo -d babana --test-enable --stop-after-init -i babana` →
**0 échec, 0 erreur, 819 tests** (955 selon le compteur `odoo.tests.stats`, qui compte
différemment) — chiffre provisoire, revu à la hausse en §4 après deux correctifs de plus.

**`make seed` rejoué sur la base fraîche** : 6 zones, 5 chauffeurs en ligne, 8 courses réglées —
sans anomalie nouvelle (le message « 8 envois de facture encore en vol après 120s » est le
comportement documenté de D57/`code/docs/odoo-pitfalls.md`, pas une nouveauté de cette nuit).

**Écran ouvert et vérifié, pas seulement compilé (point 9 de la définition de fini)** : voir §4 —
qui a trouvé deux défauts de plus, chacun corrigé, chacun rejoué sur un nouveau cycle complet
`make reset` → installation → suite Odoo → `make seed`. Résultat final de la nuit, base fraîche une
troisième fois : **0 échec, 0 erreur, 820 tests** (le test de groupe Babana en plus). `npm test`
n'a pas été rejoué cette nuit — le périmètre annoncé était la suite Odoo, et le temps de la nuit
est parti dans les cycles `make reset` décrits ci-dessus et en §4 plutôt que dans une nouvelle
traversée complète de `npm test`, déjà confirmée verte les deux nuits précédentes sans régression
du côté TypeScript cette nuit (aucun fichier `.ts`/`.tsx` touché).

---

## 4. Vérification visuelle — d'abord mal comprise, puis faite pour de vrai

Point 9 de la définition de fini : un écran n'est fini que si quelqu'un l'a ouvert. Une première
passe cette nuit s'est arrêtée sur un écran resté blanc et a conclu, à tort, à un accident
d'environnement sans rapport avec le dépôt. **Ce diagnostic était faux, et deux vrais défauts se
cachaient derrière — trouvés en insistant plutôt qu'en acceptant la première explication
plausible.**

**Premier défaut, le vrai responsable de l'écran blanc : `base.user_admin` n'a jamais été ajouté
à `babana.group_babana_admin`, nulle part dans ce module.** En rouvrant `/odoo/action-babana.
babana_audit_log_action` (« Journal d'audit », un écran d'hier soir, aucun rapport avec le code de
cette nuit) après avoir cliqué une seconde fois sur la grille d'applications, une boîte de
dialogue « Access Error » est apparue — restée invisible aux tentatives précédentes, sans qu'une
cause précise ait été identifiée pour ce rendu manqué, mais reproductible et lisible une fois
révélée : *« You are not allowed to access 'Journal d'audit immuable (L8-09)' (babana.audit.log)
records. This operation is allowed for the following groups: Babana/Administrateur. »* Le compte
`admin`, sur une base réellement vidée cette nuit par `make reset`, n'appartient à AUCUN groupe
Babana — ni administrateur, ni gestionnaire, ni superviseur. `babana_groups.xml` ne l'y a jamais
ajouté, et rien d'autre dans le module ne le fait. Les nuits précédentes ne l'ont jamais vu parce
qu'un humain avait accordé ce groupe à la main, tôt dans le projet, sur une base qui n'a plus
jamais été vraiment vidée depuis — un état jamais capturé dans les données du module, donc invisible
à quiconque installerait ce module pour de vrai.

`_post_init_admin_password` (`__init__.py`, D43) pose déjà le mot de passe du même compte pour la
même raison (« rendre le back-office réellement accessible ») — il lui manquait la moitié utile :
un mot de passe qui fonctionne mais ouvre sur une erreur d'accès au premier écran n'est pas un
compte opérationnel. Complété : le hook ajoute maintenant `base.user_admin` à
`group_babana_admin`, dans le même geste. Nouveau test,
`test_admin_user_belongs_to_babana_admin_group` (`tests/test_admin_password.py`), qui vérifie
l'effet réel sur la base de test — même patron que les deux tests voisins déjà présents pour le
mot de passe — et une assertion supplémentaire dans `test_does_not_touch_admin_user_when_it_raises`
pour prouver que l'appartenance au groupe, comme le mot de passe, n'est pas touchée quand
`ADMIN_PASSWORD` manque.

**Second défaut, trouvé en vérifiant vraiment l'écran une fois l'accès rétabli : les boutons du
`<footer>` ne s'affichaient nulle part.** Bandeau rouge et champs de détail rendus correctement (le
mécanisme D68 lui-même fonctionne, prouvé par une vraie panne provoquée sans mock — `create()`
patché dans un `odoo shell`, pas dans un test — puis observée dans le navigateur), mais « Marquer
comme vu » et « Actualiser » introuvables dans le DOM. Cause : `babana_audit_log_health_action`
s'ouvre en `target="current"` (plein écran, comme `babana_cash_dashboard_action`), et le client web
d'Odoo 18 ne rend un `<footer>` que pour une action en `target="new"` (boîte de dialogue) — un
`<footer>` sur une action plein écran n'est simplement jamais affiché, sans erreur, sans avertissement.
**`babana_cash_dashboard_view_form` (L9-05, `babana_remittance_views.xml`) porte exactement le même
défaut, plus ancien** : son bandeau d'aide dit littéralement « utiliser « Actualiser » ci-dessous »,
et il n'y a pas de « ci-dessous » — vérifié ce soir, reproduit à l'identique. Un écran que plusieurs
rapports précédents ont pourtant décrit comme « ouvert et vérifié ».

**Corrigé pour l'écran de cette nuit** : les deux boutons déplacés dans un `<header>` (même
patron que `babana_remittance_views.xml`, `button_validate`), le bouton « Fermer » retiré (
`special="cancel"` n'a de sens que dans une boîte de dialogue, pas sur une action plein écran).
**Pas corrigé pour le tableau de bord de caisse** : nommé ci-dessus, laissé pour une tâche dédiée —
hors périmètre de cette nuit, et une correction silencieuse d'un écran d'une autre tâche serait
exactement le genre de rustine que le protocole d'écart désapprouve. Si vous voulez qu'il soit
corrigé maintenant plutôt que consigné, dites-le et je le fais ce soir même.

**Vérifié pour de vrai, cette fois, les trois états** : connecté comme administrateur (`admin`,
mot de passe de développement), sur une base fraîche re-réinitialisée après les deux correctifs —
écran vert (« Aucun échec... ») à l'ouverture, panne provoquée par un `odoo shell` séparé qui
patche `babana.audit.log.create` puis suspend un chauffeur, écran rouge après redémarrage du
worker Odoo (le cache `ormcache` de `ir.config_parameter.get_param` ne se rafraîchit pas entre un
process `odoo shell` ponctuel et le worker HTTP de longue durée en `workers=0` — un artefact de ma
méthode de test, pas du mécanisme lui-même : en production, la panne et sa lecture se produisent
dans le même process), tous les champs de détail lisibles avec les bonnes valeurs (compteur,
horodatage, événement `driver.state_change`, modèle `babana.driver`, message d'erreur), clic sur
« Marquer comme vu » → retour immédiat à l'écran vert. **Le point 9 est couvert cette nuit, pour de
vrai.**

---

## 5. Ce qui aurait dû ne jamais être écrit

La toute première version de ce §4 disait : « c'est un accident de cette session de navigateur
automatisé, pas du dépôt » — et concluait que le point 9 restait ouvert plutôt que de continuer à
chercher. C'était une conclusion prématurée, écrite après une seule tentative et sans avoir lu le
message d'erreur qui, il s'avère, s'affichait déjà à l'écran. Deux vrais défauts dormaient
derrière ce diagnostic trop rapide, et le second (le `<footer>`) touche un écran d'une tâche
antérieure — invisible tant que le premier n'était pas levé. La leçon vaut d'être écrite deux fois
plutôt qu'une : **une page blanche sans message d'erreur visible n'est pas la preuve d'un accident
d'environnement, seulement la preuve qu'on n'a pas encore trouvé où regarder.**

---

Fichiers : `services/odoo/addons/babana/models/babana_audit_log.py`,
`services/odoo/addons/babana/models/babana_audit_log_health.py` (nouveau),
`services/odoo/addons/babana/models/__init__.py`,
`services/odoo/addons/babana/views/babana_audit_log_views.xml`,
`services/odoo/addons/babana/controllers/documents.py`,
`services/odoo/addons/babana/security/ir.model.access.csv`,
`services/odoo/addons/babana/tests/fixtures/access_matrix.json`,
`services/odoo/addons/babana/tests/test_audit_log.py`,
`services/odoo/addons/babana/tests/test_documents.py`,
`services/odoo/addons/babana/tests/test_admin_password.py`, `docs/odoo-pitfalls.md`.
