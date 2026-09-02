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

---

## 4. L6-16 — Mode dégradé réseau

### Ce qui existait déjà, et n'a pas été refait

`ConnectionState` (`offline`/`connecting`/`connected`, `@babana/api-client/realtime/handlers.ts`)
et la file WebSocket persistante (`realtime/queue.ts`, L6-04) existaient depuis un lot antérieur
-- leurs commentaires de tête citaient déjà L6-16 comme la raison d'être posés d'avance. Cette
nuit les a **consommés**, pas réécrits : le bandeau de connexion affiche directement les trois
états de `ConnectionState` (`connecting` se lit « dégradé », correspondance déjà annoncée par ces
mêmes commentaires), et la file HTTP neuve (ci-dessous) se déclenche sur le même signal de
reconnexion que la file WebSocket, sans un second mécanisme de détection réseau.

`HomeScreen.tsx` (client) portait déjà, depuis L3-20, un bandeau « Liste des chauffeurs non mise
à jour depuis N s » avec compteur vivant pendant un silence de diffusion -- exactement l'esprit du
critère 5 (« toute donnée en cache porte son horodatage ») appliqué au cas le plus visible de la
démonstration (les cinq chauffeurs proches). Ce mécanisme n'a pas été dupliqué ni généralisé ce
soir : c'est un choix de lot, pas un oubli -- voir « Ce qui reste » plus bas.

### La file HTTP hors connexion (critère 2), généralisée depuis un précédent

`packages/api-client/src/offline/` (`queue.ts`, `manager.ts`) : nouveau, sur le patron déjà posé
par `incident/offlineQueue.ts` (L8-04) -- persistance AsyncStorage, mutex de sérialisation, rejeu
dans l'ordre qui s'arrête à la première erreur encore réseau. `incident/offlineQueue.ts` documentait
lui-même pourquoi il n'avait pas généralisé `realtime/queue.ts` pour un seul consommateur (« un
module minuscule qu'il est plus sûr de dupliquer que d'étirer ») -- ce motif ne tenait plus une
fois quatre écrans (`SettlementScreen`, `ActiveRideScreen`, `RemittanceScreen`, `RideSummaryScreen`)
à porter le même besoin. `incident/offlineQueue.ts` reste tel quel (portée différente : position,
horodatage de déclenchement -- le retoucher n'apportait rien ce soir).

`createOfflineActionRunner({ httpClient })` expose `attempt(endpoint, options)` : tente l'appel
immédiatement (les réessais réseau/serveur à court terme de `client.ts`, L6-03, restent son
premier recours) ; sur un échec qui n'est ni une `ApiError` (catalogue C-01, l'état serveur a
tranché) ni une `ZodError` (réponse mal formée -- rejouer ne répare pas un schéma), l'action est
mise en file avec sa clé d'idempotence, et la promesse retournée par `attempt()` **reste en
attente** -- elle ne se résout que lorsque `flush()` réussit, plus tard, éventuellement bien après
que l'écran d'origine a cessé d'y penser. `onQueued()`, appelé de façon synchrone au moment de la
mise en file, est ce qui permet à l'écran de basculer son affichage tout de suite plutôt que
d'attendre un succès qui peut ne jamais arriver pour cette session-là.

Câblée dans chaque app (`apps/*/src/offline.ts`, même patron que `realtime.ts`) : `flush()` se
déclenche sur `onRealtimeConnectionStateChange('connected')`, aucun second mécanisme de
détection.

**Les quatre écrans concernés** : `SettlementScreen.tsx` (encaissement), `ActiveRideScreen.tsx`
(fin de course -- nouveau, cet écran n'avait aucune gestion hors connexion avant ce soir),
`RemittanceScreen.tsx` (déclaration de remise), `RideSummaryScreen.tsx` (notation). Les trois
premiers remplacent un patron manuel écrit à la main (clé d'idempotence dans un `useRef`, bouton
« Réessayer » qui relance tout l'appel) par le gestionnaire partagé -- le bouton « Réessayer
maintenant » appelle désormais `flush()`, jamais une seconde tentative avec une seconde clé.
`RideSummaryScreen.tsx` (notation) n'avait aucune gestion d'échec du tout ; `rateRide` reste sans
modèle côté serveur ce soir (`babana.rating`, L4-09, hors périmètre) -- la file fonctionnera dès
que ce modèle existera, rien à reprendre côté app à ce moment-là.

### Les actions interdites (critère 3) : un vrai défaut trouvé en les cherchant

`ProposalScreen.tsx` envoyait `proposal.accept`/`proposal.reject` par
`realtimeClient.send(...)` sans jamais vérifier l'état de connexion. Avant ce soir, un appui hors
connexion aurait été **mis en file silencieusement** par `connection.ts` (rien ne les en
excluait) et rejoué à une reconnexion arrivant potentiellement plusieurs minutes plus tard --
acceptant une proposition presque certainement déjà expirée ou attribuée à quelqu'un d'autre,
sans que le chauffeur n'ait rien redécidé. Exactement le défaut que la spécification anticipait
(« les mettre en file produirait des échecs incompréhensibles plus tard »), jamais rencontré en
pratique faute d'écran qui l'exerçait.

Corrigé à deux niveaux : `ProposalScreen.tsx` refuse l'appui tout de suite si `connectionState !==
'connected'` (nouveau texte « Hors connexion — impossible de répondre maintenant », les boutons
restent actifs -- le chauffeur retente dès reconnecté, la proposition n'est jamais abandonnée par
erreur) ; `NEVER_QUEUED_MESSAGE_TYPES` (`connection.ts`) gagne `proposal.accept`/`proposal.reject`
en garde défensive, pour qu'un futur appelant qui oublierait la vérification ne rejoue jamais ces
deux-là à l'aveugle. Un test existant (`connection.test.ts`) utilisait justement
`proposal.accept` comme témoin de « ce qui doit survivre à la file » -- remplacé par
`availability.set` (une vraie décision durable), et un nouveau test couvre explicitement que les
deux messages interdits ne sont plus jamais mis en file.

`selectDriver` (HTTP, sélection d'un chauffeur) n'a pas eu besoin du même correctif structurel :
n'étant jamais passé par la nouvelle file, un échec réseau y échoue déjà après les réessais courts
de `client.ts`, sans jamais être mis en attente. Seul le message affiché a été affiné
(`QuoteScreen.tsx`) : « Hors connexion : la sélection nécessite une connexion » plutôt qu'un
« réessayez » générique, quand l'état de connexion déjà suivi par cet écran (résilience de
l'abonnement `nearby.subscribe`, L3-05) confirme l'absence de réseau.

### Tests

`packages/api-client/test/offline/{queue,manager}.test.ts` (11 tests, dont le rejeu à la même
clé, l'arrêt du rejeu sur un réseau toujours coupé, le retrait sur erreur métier découverte
tardivement). `connection.test.ts` mis à jour (témoin remplacé, nouveau test « jamais mis en
file » pour accept/reject). Nouveaux tests dans `SettlementScreen`, `ActiveRideScreen`,
`RemittanceScreen`, `RideSummaryScreen`, `api/cash.test.ts` (mise en file, rejeu automatique,
clé d'idempotence stable). `ProposalScreen.test.tsx` : trois nouveaux tests (refus d'accepter,
refus de refuser, effacement du blocage à la reconnexion). `QuoteScreen.test.tsx` : un nouveau
test pour le message affiné. `ConnectionBanner.test.tsx` (les deux apps) : les trois états
distincts, jamais confondus deux à deux, réaction en direct à un changement d'état.

### Ce qui reste, signalé plutôt que fait en silence

Le critère 5 (horodatage des données en cache) n'a été vérifié que pour le cas déjà couvert par
L3-20 (liste des chauffeurs proches, `HomeScreen.tsx`) -- pas étendu à d'autres lectures qui
pourraient s'afficher figées sans le dire (le solde de caisse affiché en tête de
`SettlementScreen`/`CashScreen`, la position d'un chauffeur pendant `TrackingScreen`). Un
inventaire de tout ce qui affiche une donnée potentiellement périmée, puis une passe dédiée,
serait le bon calibrage pour une prochaine nuit -- mélanger ça à la file d'écriture ce soir
aurait dilué les deux.

`make reset && make up && make seed && make test` : suite Odoo 759 tests (0 échec), tous les
paquets et apps verts (api-client 90, `services/realtime` 213 -- le test instable signalé plus
haut est passé cette fois, cohérent avec un défaut d'exécution sous charge plutôt que dans le
code --, client 110, driver 193, concurrency/http-contract/config/auth 37). `make lint`,
`make typecheck`, `make secrets-scan` verts.
