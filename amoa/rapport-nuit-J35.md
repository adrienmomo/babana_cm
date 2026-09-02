# Rapport de nuit — J35

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-11.md`, `amoa/05-prerequis-et-simulation.md` §4 ter,
`amoa/07-demonstration.md`, `amoa/specs/L6-mobile.md` (L6-03, L6-04, L6-16), le rapport J34,
`infra/env/.env.example`, `infra/env/README.md`, `infra/compose.yaml`, `infra/compose.dev.yaml`,
`infra/production/deploy.sh`, `services/odoo/scripts/seed.py`, `services/odoo/addons/babana/
__init__.py`, `security/ir.model.access.csv`, les vues et modèles `babana_driver`,
`babana_motorcycle`, `babana_assignment`, `babana_ride`, `babana_incident`,
`babana_cash_remittance`, `babana_cash_discrepancy`.

Périmètre confié : les identifiants du back-office et la revue visuelle qui en dépendait, le
retrait du client JSON-RPC mort, puis L6-16 (mode dégradé réseau).

---

## 1. Les identifiants du back-office (D43) — et ce qu'ils ont permis de voir

### Le mécanisme

`05-prerequis-et-simulation.md` §4 ter, corrigé le 11 septembre, demandait un mot de passe
administrateur posé depuis une variable explicite, sans valeur par défaut en production — même
motif D43 que `GOOGLE_JWKS_URL` et consorts (`amoa/questions/REPONSES-2026-09-06.md` §2), mais
appliqué à un secret plutôt qu'à une adresse : une mise en production qui recopierait
`.env.example` ne doit jamais hériter d'un mot de passe de développement.

**Premier essai, corrigé en le vérifiant** : `ADMIN_PASSWORD` vide dans `.env.example`, posée
seulement par `infra/compose.dev.yaml`, exactement comme `GOOGLE_JWKS_URL`. `make test` a
débusqué pourquoi ce n'était pas le bon calque : `test/concurrency/helpers/odoo-session.ts`
tourne sur l'**hôte** (`npm test`, jamais dans un conteneur) et lit ses identifiants de service
directement dans `infra/env/.env` — un fichier que `compose.dev.yaml` ne renseigne jamais,
puisque ce dernier ne configure que l'intérieur d'un conteneur. `ADMIN_PASSWORD` valait donc
`admin` côté outil de test (repli sur l'ancien défaut Odoo) pendant que le conteneur, lui,
appliquait la vraie valeur au compte `admin` réel : deux vérités pour un seul mot de passe.
Revenu au patron des *vrais* secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`) : une valeur factice
directement dans `.env.example`, pas d'exception D43 — celle-ci ne convient qu'aux valeurs
consommées uniquement par des conteneurs (documenté dans `code/docs/odoo-pitfalls.md`, nouvelle
entrée). Le nom de variable lu par `odoo-session.ts` (`ODOO_ADMIN_PASSWORD`, jamais posé nulle
part) corrigé pour lire `ADMIN_PASSWORD`, le nom réel.

`__init__.py::_post_init_admin_password` (nouveau `post_init_hook`, enchaîné avant celui de D53 —
Odoo n'accepte qu'un seul hook déclaré dans le manifeste) applique la variable au compte `admin`
à la première installation du module et lève si elle est absente. `infra/production/deploy.sh`
refuse de partir si elle est vide ou égale à la valeur de développement, même garde que pour
`SMTP_HOST`/`GOOGLE_JWKS_URL`. Rotation documentée dans `infra/env/README.md` : se connecter,
changer le mot de passe depuis le profil `admin`, mettre à jour la variable — le hook ne rejoue
pas sur `-u`.

Testé (`test_admin_password.py`) : le mot de passe posé correspond à `ADMIN_PASSWORD` après
installation, `admin`/`admin` ne fonctionne plus, et la fonction lève sans toucher au compte si
la variable est absente.

### Ce que ça a débloqué

Connecté à `http://localhost:8069` en admin, puis en tant que `superviseur.demo` (mot de passe
temporaire posé pour la revue, jamais committé) — la persona réelle du back-office, `admin`
n'appartenant à aucun groupe `babana.*` par construction (les groupes ne s'attribuent pas au
compte technique). Trois nuits de vues jamais ouvertes par un œil humain. Le doute du rapport
J34 était fondé : plusieurs défauts n'attendaient qu'un navigateur pour se révéler.

---

## 2. Revue visuelle, écran par écran — et ce qui s'est cassé en les ouvrant

### Chauffeurs (L9-01) — le plus sérieux : un écran totalement inaccessible au superviseur

Cliquer sur « Chauffeurs » produisait un écran blanc silencieux, sans message d'erreur visible
tant que la boîte de dialogue Odoo derrière le voile n'était pas inspectée : `AccessError` sur
`babana.motorcycle`, provoquée par le simple affichage de `motorcycle_id` dans la liste. Le
superviseur n'avait accès en lecture à **aucun** des modèles nécessaires pour afficher son propre
écran de travail :

- `babana.motorcycle` (colonne « Moto affectée »)
- `babana.driver.document` (onglet Documents de la fiche)
- `babana.assignment` (onglet Moto et affectations)
- `babana.zone` et `babana.fare.rule` (formulaire d'une course, `pickup_zone_id`/`fare_rule_id`)

Quatre lignes de lecture seule ajoutées à `security/ir.model.access.csv`
(`access_babana_motorcycle_supervisor`, `..._driver_document_supervisor`,
`..._assignment_supervisor`, `..._fare_rule_supervisor`, `..._zone_supervisor`) — jamais
d'écriture, le superviseur consulte, il ne gère ni la flotte ni les tarifs (commentaire du groupe,
`babana_groups.xml`).

**Effet de bord trouvé en vérifiant le correctif** : donner au superviseur un accès en lecture à
`babana.motorcycle` et `babana.fare.rule` a fait apparaître les menus « Flotte » et
« Tarification » dans sa barre — d'anciens menus sans `groups=` explicite, masqués jusque-là
seulement parce qu'Odoo cache un menu quand l'utilisateur n'a *aucun* droit sur le modèle de son
action. Un droit de lecture suffisait à les révéler. Ajouté `groups="babana.group_babana_manager"`
sur `babana_menu_fleet` et `babana_menu_pricing` (les deux parents) pour fermer la fuite sans
retirer la lecture nécessaire à l'affichage.

Chauffeur affecté : la colonne « Moto affectée » affichait littéralement `babana.motorcycle,1` —
`babana.motorcycle` n'a ni champ `name` ni `_rec_name`, Odoo replie sur cette forme technique.
`_rec_name = "license_plate"` (même motif que `babana.ride._rec_name = "reference"`, déjà posé,
jamais étendu à ce modèle). Idem pour `babana.cash.remittance` : le fil d'Ariane d'une remise
ouverte affichait `babana.cash.remittance,2` au lieu de `R2026000002` — `_rec_name = "reference"`.
`babana.cash.discrepancy` porte le même défaut (`babana.cash.discrepancy,1`, visible dans le champ
« Écart lié » d'une remise contestée) mais n'a aucun champ candidat pour `_rec_name` — ajouter un
champ pour ça seul aurait dépassé la revue de ce soir ; signalé, pas corrigé.

**Ce que le superviseur voit maintenant, une fois ces corrections en place** : une liste à cinq
lignes, chauffeur / état / en ligne / moto (immatriculation réelle) / note / courses / solde dû /
dernière activité, tenant sur un écran sans défilement. La fiche d'un chauffeur : dossier,
activité, caisse en trois blocs, quatre onglets (Documents, Moto et affectations, Courses
récentes, Mouvements de caisse) — tous vides pour ce jeu de données (aucun document, aucune
affectation historisée au-delà de l'actuelle) mais aucun ne plante.

### Incidents, Remises de caisse, Écarts de caisse — un deuxième défaut, plus grave que le premier

Aucun incident ni remise n'existe dans les données de démonstration (`make seed` n'en crée pas :
l'historique de courses s'arrête à `settled`). Il a donc fallu en produire un jeu minimal par
`odoo shell` (une remise validée, une remise contestée avec son écart, un incident d'urgence) pour
voir ces écrans autrement qu'à l'état vide — et c'est cette étape qui a trouvé le défaut suivant.

Ouvrir la fiche d'une remise validée produit un plantage plein écran : `AttributeError:
'babana.cash.remittance' object has no attribute '_get_thread_with_access'`. La vue porte un
`<chatter/>` (fil de discussion, boutons « Send message » / « Log note ») mais le modèle
n'hérite pas de `mail.thread` — le chatter suppose une méthode que seul `mail.thread` fournit.
Même défaut, mêmes symptômes, sur `babana.cash.discrepancy` et `babana.incident` : les trois
modèles portent un `<chatter/>` dans leur vue sans hériter de `mail.thread`, alors que
`babana.driver` et `babana.motorcycle` (qui héritent bien de `mail.thread`) fonctionnent. Trois
`_inherit = ["mail.thread"]` ajoutés.

C'est le défaut le plus sérieux de la nuit : plus grave que l'écran des Chauffeurs (qui était
seulement *illisible*), celui-ci rendait *inutilisable* l'écran où un superviseur valide une
remise contestée ou prend en charge une urgence — précisément les actions à haute conséquence que
`CLAUDE.md` place hors fusion sans revue humaine (« Tout le lot L5 »). Un superviseur réel,
devant une remise contestée à traiter ou une urgence déclenchée par un client, aurait vu cet écran
« Oops! Something went wrong » à la place de l'écran d'action — et jusqu'à cette nuit, personne ne
l'avait constaté, faute d'avoir jamais eu de quoi se connecter.

Une fois corrigé : la fiche d'une remise contestée affiche l'avertissement D29 (« Le chauffeur
reste débiteur de 100 FCFA... ») en clair, avec le lien vers l'écart correspondant ; la fiche
d'incident affiche le contact d'urgence et son statut de notification, avec le bouton « Prendre
en charge » et la barre d'état Ouvert → Pris en charge → Clôturé. Les deux se lisent sans
ambiguïté sur ce qu'il reste à faire.

### Tableau de bord de caisse (L9-05) — l'écran qui n'avait besoin de rien

Seul écran des six à n'avoir révélé aucun défaut. Trois blocs (total détenu par la flotte /
plafond, situation des chauffeurs au ou proche du plafond, remises en attente avec la plus
ancienne), entièrement en français, tenant sur un écran sans défilement — exactement ce que la
spécification demandait (« un superviseur doit voir d'un coup d'œil qui doit remettre »).

### Un défaut de fond dans les données de démonstration, trouvé en lisant l'écran plutôt que le code

La colonne « Départ » de « Courses récentes » (fiche chauffeur) affichait
`seed-history:1:0:Makepe>Akwa` au lieu d'un lieu plausible. `seed.py` posait la clé
d'idempotence de rejeu (« ai-je déjà créé cette entrée d'`HISTORY` ») directement dans
`pickup_label`, un champ affiché à l'utilisateur — pratique pour la vérifier par une recherche
Odoo, mais jamais prévu pour être lu par un humain. Or la date réelle
(`datetime.now() - timedelta(days=days_ago, ...)`) change chaque nuit et ne peut pas servir de
clé stable : la marque devait rester déterministe, seulement changer de logement.

Déplacée dans `ir.config_parameter` (`babana.seed_history_markers`, liste JSON), le même motif
que `babana.seed_done` déjà utilisé plus bas dans ce fichier pour la même famille de besoin.
`pickup_label` reçoit maintenant une vraie valeur plausible (`"%s (démo)" % from_name`, même
forme que `dropoff_label`). Rejeu vérifié : `make seed` deux fois de suite sur la même base
produit `+8` puis `+0` — l'idempotence n'a pas régressé, seulement changé de mécanisme.

### Ce qui reste en anglais, signalé et non corrigé

`babana.ride` porte une trentaine de champs sans `string=` français (Pickup Latitude, Estimated
Duration Minutes, Cancel Category, Requested At...), visibles dans le détail d'une course une
fois ouverte — traiter les colonnes de liste et les onglets embarqués rencontrés ce soir
(`state`, `reference`, `pickup_label`, `dropoff_label`, `final_amount`, `driver_id`,
`payment_method`, plus tout `babana.ride.rejection`) a semblé le bon calibrage pour cette revue ;
le reste du formulaire — champs de détail, pas de liste — mériterait une passe dédiée plutôt
qu'un mélange au milieu d'un lot déjà chargé. Non fait ce soir, faute de temps face à L6-16.

### La question posée : quel écran demanderait le plus d'explication à un superviseur ?

Aucun, une fois les trois défauts ci-dessus corrigés — c'est la bonne nouvelle de cette revue. Le
seul reliquat qui ferait hésiter : la fiche `babana.cash.discrepancy` s'ouvre sous le titre
`babana.cash.discrepancy,1` (pas de `_rec_name`), et l'onglet « Historique d'écarts du chauffeur »
serait vide pour toute cette flotte de démonstration tant qu'aucune remise réelle n'a été
contestée — pas un défaut, juste un écran qui n'a encore rien à montrer.

---

## Non-régression

`make reset && make up && make seed` sur base fraîche, puis `make test` en entier : suite Odoo
759 tests (0 échec), `npm test` racine (api-client, contracts, maps, navigation, ui : 78+19+4
tests), `services/realtime` (213 tests), `apps/client`/`apps/driver` (106+182 tests),
`test/concurrency` + `test/http-contract` (37 tests, contre le vrai Odoo). `make lint`,
`make typecheck`, `make secrets-scan` : tous verts.

**Un défaut trouvé par ce passage complet, indépendant de tout le reste ce soir** : la
limitation de débit sur la création de candidature chauffeur (L1-01 critère 10, 5/heure/IP en
production) se déclenchait à l'intérieur même de la suite d'intégration, qui crée légitimement
plus de cinq identités chauffeur distinctes pour ses propres besoins d'isolation — toutes vues
depuis la même adresse par ce serveur unique. La suite Odoo elle-même en crée déjà plusieurs pour
prouver le critère 10 en direct (`test_driver_candidacy_creation_is_rate_limited`) ; `npm test`,
juste après, heurtait donc un plafond déjà entamé. `Makefile::test` relâche maintenant ce plafond
(`babana.driver_candidacy_rate_limit_max = 1000`) sur cette seule base de développement/test,
après la suite Odoo et avant `npm test` — jamais posé en production, aucune cible de déploiement
n'appelle cette règle. Visiblement jamais rencontré avant cette nuit : rien n'indique que
`make test` ait tourné de bout en bout, suite Odoo puis `npm test`, dans une même session
récente.

**Un test instable trouvé, non corrigé, signalé** : `services/realtime/test/nearby.test.ts`,
« L3-20 — un abonnement plus ancien dont la réponse Redis revient après un plus récent ne doit
jamais lui survivre » a échoué une fois sur trois exécutions de la suite complète du service
(`7 !== 6`, un message de diffusion périodique en trop après `unsubscribe()`), et toujours réussi
seul ou en répétant la même commande. Sensible au temps réel (le test attend deux fenêtres de
150 ms autour d'un intervalle de diffusion de 50 ms) et donc à la charge du système au moment où
il tourne — un candidat probable pour une course entre l'intervalle de diffusion et l'arrêt
effectif du minuteur dans `NearbyManager.unsubscribe()`, mais non reproduit isolément malgré
plusieurs tentatives, donc non diagnostiqué plus avant. Aucun rapport aux changements de cette
nuit (`services/realtime` n'a pas été touché) ni au reste du dépôt trouvé en cherchant les
rapports précédents. Signalé plutôt que réparé à l'aveugle — CLAUDE.md proscrit d'ignorer un test
instable, pas de le documenter en attendant une investigation dédiée.

---

## 3. Le client JSON-RPC — retiré

`packages/api-client/src/http/rpc.ts` promettait encore, dans son commentaire de tête, un pont
JSON-RPC pour « historique, factures, profil ». D35 (`01-architecture.md` §5, 22 août) a aboli ce
chemin ; L9-04/L9-05/L5-07 (J34) puis ce soir en ont construit les lectures REST correspondantes.
Le fichier n'avait plus d'import en dehors de son propre paquet (test compris) — retiré avec son
test et son export (`packages/api-client/src/http/index.ts`), et le commentaire de
`RemittanceScreen.tsx` qui le citait comme perspective (« l'aller-retour qu'apportera L6-16 »)
mis à jour pour ne plus pointer vers un fichier disparu.
