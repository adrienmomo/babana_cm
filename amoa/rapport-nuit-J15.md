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
