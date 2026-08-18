# Rapport de nuit — J15

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-23.md` lu en entier avant d'ouvrir quoi que ce
soit. §1 passe avant tout le reste : c'est une correction de sécurité, pas une tâche du lot.

---

## D37 — le jeton rejouable est chiffré, rien ne survit à la fenêtre

**Ce que le rapport J14 avait sous-estimé.** `amoa/questions/L1-02.md` posait la bonne question
(rejouer un jeton exige de le garder récupérable, un haché ne s'inverse pas) mais concluait à une
« conséquence acceptée à surveiller » — un vestige rare, borné à la fenêtre de grâce. La relecture
demandée cette nuit a montré que ce n'était pas le cas : `next_raw_token` n'était effacé qu'à une
**représentation tardive** de l'ancien jeton, un chemin qui ne s'exécute jamais dans le cas normal
(le client reçoit son nouveau jeton et ne repasse plus l'ancien). Chaque renouvellement laissait
donc en base, **définitivement**, le jeton de renouvellement actuellement valide de l'utilisateur,
en clair. Pas un vestige — le jeton vivant. Un vidage de base aurait donné la session de chaque
utilisateur ayant renouvelé une fois.

**Tests écrits en premier, vus rouges.** Avant de toucher au modèle :
`test_next_token_is_never_stored_in_clear` (lit `babana_token` par SQL brut, pas par le nom du
champ — sinon on ne prouve que « le champ qu'on a choisi de lire est absent », pas que la valeur
en clair n'existe nulle part sur la ligne) et
`test_cron_purges_ciphertext_past_grace_window_even_if_nobody_returns` (le cas normal : un client
qui renouvelle et ne repasse jamais). Les deux échouaient contre le code d'avant cette nuit — le
premier parce que `next_raw_token` contenait bien le jeton en clair, le second parce qu'aucune
tâche périodique n'existait.

**Correctif : `next_raw_token` → `next_token_ciphertext`.** Le remplaçant est chiffré (AES-256-GCM,
`cryptography`, déjà tiré transitivement par `PyJWT[crypto]` — aucune dépendance nouvelle, seulement
un import direct désormais documenté dans `services/odoo/Dockerfile`) avec une clé dérivée par
SHA-256 du jeton **présenté** à cette ligne, jamais stockée elle-même. Séparation de domaine entre
cette clé et `token_hash` (préfixe distinct) : les deux dérivent du même jeton en clair, mais ne
sont jamais la même valeur — défense en profondeur peu coûteuse, pas une nécessité cryptographique
stricte.

Le client qui a le droit de rejouer est exactement celui qui possède l'ancien jeton : il fournit
donc du même geste la clé de son remplaçant. Un vidage de la base ne donne rien de déchiffrable,
puisque la clé n'y est jamais écrite — seul son haché SHA-256 (`token_hash`, préexistant) l'est,
et un haché ne s'inverse pas.

**Nettoyage périodique, pas seulement à la prochaine présentation.** Nouveau
`ir.cron` (`data/cron.xml`, toutes les minutes) appelant
`babana.token._cron_purge_expired_replay_ciphertext()` : efface `next_token_ciphertext` sur toute
ligne `rotated` dont `rotated_at` dépasse la fenêtre de grâce configurée, sans attendre qu'un
client vienne redemander ce jeton précis. C'est la pièce qui manquait à J14 — signalée comme
question ouverte dans `L1-02.md`, maintenant tranchée.

**Fichiers.** `services/odoo/addons/babana/models/babana_token.py` (champ, chiffrement/
déchiffrement, cron), `services/odoo/addons/babana/data/cron.xml` (nouvel `ir.cron`),
`services/odoo/addons/babana/tests/test_token.py` (deux tests neufs, un renommage de champ dans
un test existant), `services/odoo/Dockerfile` (commentaire), `amoa/questions/L1-02.md` (section
« Résolu — D37 » ajoutée). D37 était déjà consigné dans `amoa/01-architecture.md` par le débrief
J14 — rien à y changer, seulement à implémenter.

**Vérification.** Suite Odoo complète sur base fraîche (`make reset && make up`, `-i babana`) :
**400 tests, 0 échec**, y compris les 15 de `TestBabanaToken`. `npm test` racine : vert (voir
« Vérification finale » en fin de rapport pour la sortie complète, tenue une seule fois pour
l'ensemble de la nuit plutôt que répétée tâche par tâche).

**Ce que je retiens.** La même leçon que D26/D33, redite dans le débrief J14 : une décision qui
ajoute une commodité peut retirer une garantie posée ailleurs sans qu'aucune des deux ne paraisse
fausse isolément. Ici la garantie perdue était une propriété de sécurité, et rien ne la vérifiait —
elle vivait dans une phrase de contrat (« seul le haché est stocké »), pas dans une assertion.
Les critères 3 ter et 3 quater la rendent désormais mécanique : un test qui lit la table, pas un
test qui relit l'intention.

---

## Les trois doutes de L6-06

Les trois arbitrages du débrief J14 §2, implémentés ensemble puisqu'ils touchent le même écran et
partagent un même fil : ce qu'un client réel comprend d'un signal qu'on lui montre.

**§1 — « vers <lieu> », pas un fait.** `labelFor` (`HomeScreen.tsx`) préfixe désormais tout
libellé issu du géocodage inverse par `vers `, et un rappel permanent sous la carte (`📍 C'est le
point sur la carte qui fait foi, le libellé n'est qu'une indication.`) — visible en toute
circonstance, pas seulement pendant le géocodage. Le résultat d'une recherche textuelle
délibérée (`PlacePicker` → `handlePlaceSelected`) ne passe jamais par `labelFor` et garde son
libellé exact : ce n'est pas une approximation du même genre, c'est un choix explicite du client.

**§2 — trois échecs, trois messages.** `getCurrentPosition` ne renvoie plus `LatLng | null` mais
`LocationResult` (`apps/client/src/location.types.ts`, nouveau fichier neutre importé par
`location.ts` ET `location.web.ts` — une seule table de correspondance des codes d'erreur
`GeolocationPositionError` du standard W3C, partagée entre natif et web plutôt que dupliquée).
Trois `reason` distincts (`permission-denied`, `position-unavailable`, `timeout`), trois messages
et un bouton « Réessayer » qui relance la capture (`retryLocation`, factorisée depuis l'effet de
montage pour être rejouable). Le départ reste désignable à la main dans les trois cas, sans
changement de ce côté.

**§3 — un silence est le pire retour possible pour une limitation de débit.** Nouveau message
`nearby.subscribe.ack` (C-02, `NearbySubscribeAckPayloadSchema`, discriminé sur `accepted` :
`{accepted: true}` ou `{accepted: false, retryAfterMs}`) — répond désormais à **chaque**
`nearby.subscribe`, jamais seulement aux acceptés. `NearbyManager.allowSubscribe`
(`services/realtime/src/nearby/handler.ts`) renvoie maintenant `{allowed, retryAfterMs?}` plutôt
qu'un booléen : le délai est calculé depuis la plus ancienne tentative retenue dans la fenêtre de
débit, pas une constante. Côté écran, un état `subscribeRefusal` distinct de `nearbyDrivers`
vide : « Votre demande n'a pas été prise en compte, patientez N s avant de réessayer » plutôt que
la confusion avec « Aucun chauffeur disponible ». Effacé dès qu'une liste de chauffeurs arrive à
nouveau.

**Effet de bord assumé sur les tests existants.** `NearbyManager` répond désormais toujours (au
lieu de rien, sur refus) : les trois tests de `nearby.test.ts` qui comptaient les messages ont dû
être réécrits pour filtrer par type (`driverListMessages`, `ackMessages`) plutôt que de supposer
que "tout message reçu est une liste de chauffeurs" — c'était vrai avant cette nuit, plus
maintenant. Même chose côté contrat : `packages/contracts` rebuild (`npm run build -w
packages/contracts`) nécessaire avant que les autres paquets voient le nouveau type dans
`dist/` — noté ici parce que ce n'est pas automatique dans ce monorepo (pas de `pretest` qui
reconstruit les dépendances de workspace).

**Fichiers.** `packages/contracts/src/realtime/server-to-client.ts` (+test),
`docs/contracts/realtime-events.md`, `services/realtime/src/nearby/handler.ts` (+test),
`apps/client/src/location.types.ts` (nouveau), `apps/client/src/location.ts`,
`apps/client/src/location.web.ts` (+test), `apps/client/src/screens/HomeScreen.tsx` (+test).

**Vérification.** `packages/contracts` (66 tests), `services/realtime` (test/nearby.test.ts, 8
tests, contre Redis réel) et `@babana/client` (41 tests, jest) tous verts. `tsc --noEmit` sur les
quatre paquets touchés (contracts, realtime, api-client, client) sans erreur. Suite complète du
service temps réel (`npm test`, `services/realtime`) : le flake déjà documenté
(`DisconnectGraceTimers`, J14 rapport §4, minuteurs sous charge combinée) réapparaît de façon
intermittente, reconfirmé isolé (3/3 tests verts) -- sans rapport avec cette nuit, non traité
comme convenu (« à traiter quand il gênera »).

---

## L6-07 — estimation, détail décomposé, choix du chauffeur

`QuoteScreen.tsx` : appel à `/quote` au montage et à chaque changement de gamme (toggle
Standard/Confort, toujours proposé -- rien ne dit aujourd'hui côté serveur qu'une gamme serait
indisponible dans une zone, donc pas de condition à vérifier avant de l'afficher). Montant en
gros, détail décomposé juste dessous **sans dépliant** (D20, critère 1) : prise en charge,
distance toujours affichées ; majoration, remise, ajustement plancher, arrondi seulement quand
non nulles -- une ligne à zéro ne change rien à la somme, l'identité « les composantes affichées
somment exactement le total » (L2-03, critère 4) tient donc qu'elle soit montrée ou non. Distance
et ETA corrigé (`≈ N min`, É8/L10-03 -- le facteur vaut 1.0 aujourd'hui, non calibré, donc pas de
fausse précision à la minute ni à la seconde). Compte à rebours de validité ; à expiration,
`USER_MESSAGES.QUOTE_EXPIRED` et un bouton « Réactualiser », jamais un échec sec.

**Aucun calcul de tarif dans l'app** (critère 5) : `quote.amount` et `quote.breakdown` sont
affichés tels que reçus. La seule arithmétique côté client est `Math.abs()` pour l'affichage du
signe de la remise -- pas une règle métier, une mise en forme.

**Les 5 chauffeurs viennent d'un cliché, pas d'un second abonnement.** `HomeScreen` passe sa
liste `nearbyDrivers` (déjà tenue à jour en direct par L3-05) dans les paramètres de navigation
plutôt que de faire ouvrir à `QuoteScreen` un second `nearby.subscribe` pour la même position --
choix d'implémentation non spécifié, documenté dans `navigation/types.ts`. Conséquence acceptée :
la liste ne bouge plus une fois sur `QuoteScreen`, jusqu'à la sélection. Le serveur reste
l'arbitre final (`DRIVER_ALREADY_TAKEN` si un chauffeur affiché a été pris entre-temps, invariant
4) -- l'app n'affiche jamais une disponibilité qu'elle n'a pas vérifiée elle-même, elle affiche ce
que L3-05 lui a donné, et laisse le serveur trancher à la sélection.

`DriverCard.tsx` (nouveau) : toute la carte est la zone de sélection, pas un bouton à viser à
part -- terminal d'entrée de gamme, geste le plus direct possible. Mise en forme (distance par
paliers, « Nouveau » plutôt qu'une note à zéro, gamme) extraite de `DriverMarker.tsx` vers
`driverFormatting.ts` : les deux composants affichent le même `NearbyDriver` sous deux formes,
la règle d'affichage ne doit être écrite qu'une fois.

**Fichiers.** `apps/client/src/screens/QuoteScreen.tsx` (nouveau), `components/DriverCard.tsx`
(nouveau), `components/driverFormatting.ts` (nouveau, extrait de `DriverMarker.tsx`),
`navigation/types.ts` (`Quote` gagne `nearbyDrivers`), `navigation/index.tsx` (branché,
remplace le `PlaceholderScreen`), `screens/HomeScreen.tsx` (`handleNext` transmet la liste).

**Vérification.** `@babana/client` : 51 tests (8 nouveaux pour `QuoteScreen`, 2 pour
`DriverCard`, `DriverMarker` inchangé après extraction). `tsc --noEmit` et `eslint` propres.
Un piège de test noté pour la suite : `toLocaleString('fr-FR')` sépare les milliers par une
espace fine insécable (U+202F), invisible dans un éditeur -- comparer contre la même fonction,
jamais contre une chaîne de test tapée à la main avec une espace ordinaire (le premier jet de ces
tests échouait pour cette seule raison). Deuxième piège : un `setInterval` réel (le compte à
rebours) qui survit à la fin d'un test tant que le rendu n'est pas démonté explicitement --
`react-test-renderer` ne démonte rien tout seul entre les tests d'un même fichier, contrairement
à ce qu'on pourrait supposer. Consigné dans `code/docs/odoo-pitfalls.md` ? Non -- ce n'est pas un
piège Odoo, c'est un piège Jest/RN ; à documenter si un deuxième écran avec compte à rebours le
reproduit.

**Ce qui me laisse un doute pour un client réel.** Le cliché de chauffeurs ne se corrige jamais
pendant que le client compare et hésite sur `QuoteScreen` -- si l'estimation prend son temps à
lire, un des cinq peut avoir disparu du pool sans que rien ne le signale avant le tap. Le
`DRIVER_ALREADY_TAKEN` renvoyé à la sélection est correct et sûr, mais l'expérience est mauvaise :
un message d'erreur générique plutôt qu'un rafraîchissement discret de la carte concernée. Ce
n'est pas un défaut de cette tâche au sens des critères d'acceptation, mais c'est le genre
d'aspérité qu'un utilisateur réel remarque à la deuxième course.
