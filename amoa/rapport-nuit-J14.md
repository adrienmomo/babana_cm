# Rapport de nuit — J14

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-22.md` lu en entier avant d'ouvrir quoi que ce
soit — §1 et §2 arbitrent les deux ponts manquants du rapport J13 en une seule cause (D35) et sa
conséquence (D36).

---

## Vérification préalable, sur base fraîche

Demandée explicitement en tête de nuit : deux sessions consécutives sans confirmer la suite Odoo
et le test de concurrence, c'est une de trop (rapport J13 §« Vérification finale »).

`make up` : propre. Suite Odoo complète (`-i babana`, base fraîche) : **386 tests, 1 échec**
avant toute écriture de code cette nuit — `TestBabanaToken.test_rotate_produces_new_pair_and_invalidates_old`.
`npm test` (racine, y compris `test/concurrency` et `test/auth`, L4-11) : tout vert, y compris le
scénario 3 (encaissement concurrent). Un flake déjà documenté (`DisconnectGraceTimers`,
`services/realtime/test/availability.test.ts`) est réapparu sous charge combinée, reconfirmé isolé
(3 tests, 0 échec) — même défaut temporel que J12/J13, sans rapport avec cette nuit.

**L'échec Odoo n'était pas un défaut de production, mais un défaut du test lui-même**, découvert
en le lisant avant d'y toucher (CLAUDE.md, « une dépendance supposée absente se vérifie dans le
dépôt ») : `old_record = self.env["babana.token"].sudo().search([("token_hash", "!=", False)],
order="id asc", limit=1)` cherche le **plus ancien enregistrement de toute la table**, pas celui
du jeton émis par ce test. `test_auth.py` (HttpCase, requêtes HTTP réelles donc commitées, pas
annulées comme une TransactionCase) laisse des `babana.token` antérieurs dans la même base de
test — un tri par id global attrapait le mauvais enregistrement, un défaut latent qui ne se
manifestait que selon l'ordre d'exécution des suites. Corrigé en cherchant par le hachage du
jeton précisément émis par le test (même patron que `test_logout_revokes_only_that_token_not_the_family`,
juste en dessous dans le même fichier). Puisque D36 (à suivre) touche exactement ce fichier
cette nuit, la correction voyage avec lui plutôt que d'ouvrir une tâche à part.

---

## D35 — `GET /me`, JSON-RPC abandonné pour les apps

**Ce qui existait avant.** `01-architecture.md` §5 réservait les lectures secondaires (historique,
factures, profil) au JSON-RPC natif d'Odoo. Personne n'avait vérifié que ce JSON-RPC accepte le
jeton applicatif — il ne l'accepte pas, il authentifie par session de cookie ou par identifiants
explicites. Le code avait détourné `/auth/refresh` au démarrage pour obtenir malgré tout un profil
à jour.

**Contrat (C-01, `packages/contracts/src/http/auth.ts`).** L'objet utilisateur, jusque-là déclaré
inline dans `AuthSessionSchema.user`, devient `AuthenticatedUserSchema`, une définition partagée.
`MeResponseSchema` la réutilise telle quelle — « même schéma, une seule définition », littéralement
la même constante des deux côtés, pas deux schémas qui se ressemblent. `GET /me` entre au registre
`HTTP_ENDPOINTS` (`packages/contracts/src/http/index.ts`), `requiresAuth: true`, sans erreur
propre au-delà des erreurs implicites (`UNAUTHORIZED`, `TOKEN_EXPIRED`) : une lecture de profil ne
refuse jamais un chauffeur non approuvé, même raison que `/auth/google` critère 8. Vingtième
endpoint du contrat (`generate-json-schema.ts` : 19 → 20). `docs/contracts/http-api.md` mis à jour
dans la foulée.

**Odoo (`controllers/auth.py`).** Nouvelle route `GET /api/v1/me`, seule route de ce contrôleur
authentifiée par `Authorization: Bearer` (`_common.authenticated_user()`) plutôt que par un jeton
transmis dans le corps — les trois autres routes de ce fichier restent sur leur mécanisme propre
(`amoa/questions/L1-02.md`). `_build_session` et le nouvel handler partagent désormais
`_build_user_payload(user, picture=None)` : un seul point de construction du payload utilisateur
côté serveur, miroir du « une seule définition » côté contrat. Tests dans un nouveau
`tests/test_me_controller.py` (profil client, profil chauffeur `pending` avec son statut, jeton
manquant, jeton illisible, jeton expiré) — même patron que `test_driver_cash_controller.py`.

**Client (`packages/api-client`, apps).** `AuthClient.refreshUser(httpClient)` (nouveau,
`session.ts`) appelle `GET /me` et remplace `state.user` sans toucher aux jetons. Il prend le
client HTTP en paramètre plutôt que d'utiliser `this.config.httpClient` : c'est le client enrobé
de renouvellement transparent (`withTransparentRefresh`, construit à l'extérieur d'`AuthClient` à
partir de cette même instance) qu'il faut lui passer, pour que le renouvellement redevienne une
réaction à une expiration plutôt qu'un appel systématique — exactement ce que la nuit demandait.
Les deux `navigation/index.tsx` (Client, Chauffeur) appellent `authClient.refreshUser(apiClient)`
à la place de l'ancien `authClient.refresh()` proactif ; le commentaire qui expliquait le
détournement est réécrit pour expliquer la solution. Tests mis à jour dans les deux
`AppNavigator.test.tsx` (mock `refreshUser` au lieu de `refresh`) et un nouveau cas dans
`session.test.ts`.

**`createJsonRpcClient` n'a pas été retiré.** Il ne coûte rien (un seul fichier, testé contre un
double, aucune dépendance nouvelle) et aucune tâche ne s'appuie dessus depuis L6-03 — le retirer
serait une suppression de code fonctionnel sans bénéfice mesurable ce soir. À reconsidérer si une
tâche future (L6-10 ?) confirme qu'aucune lecture ne l'utilisera jamais.

Vérifié : suite `@babana/contracts` (65 tests), `@babana/api-client` (49 tests), suite Odoo ciblée
puis complète (390 tests sur base fraîche, 0 échec), `@babana/client` (11 tests), `@babana/driver`
(15 tests), `npm run typecheck --workspaces` propre sur les onze paquets/apps.

---

## D36 — fenêtre de grâce sur la rotation du jeton de renouvellement

**Le problème que la relecture a trouvé, pas le rapport J13.** La rotation (L1-02) révoque toute
la famille à la réutilisation d'un jeton consommé — bonne règle contre le vol, mauvaise hypothèse
sur le réseau : une coupure entre l'envoi du jeton et la réception de son remplaçant laisse
l'ancien consommé côté serveur et rien de nouveau côté téléphone. Sans fenêtre, l'app suivante
présente ce seul jeton et perd toute sa famille.

**Modèle (`models/babana_token.py`).** Deux champs nouveaux sur `babana.token`, uniquement posés
à la rotation : `rotated_at` (horodatage de la rotation, borne de la fenêtre) et `next_raw_token`
(le jeton de renouvellement en clair déjà émis en remplacement). `_rotate` distingue désormais
trois cas à la présentation d'un jeton non actif :

- `state == 'rotated'` **et** dans la fenêtre (`ir.config_parameter`,
  `babana.token_reuse_grace_seconds`, défaut 30 s) : renvoie `record.next_raw_token` tel quel — le
  couple déjà émis, ni révocation, ni troisième jeton.
- `state == 'rotated'` et hors fenêtre : efface `next_raw_token` (il ne sert plus à rien, ne doit
  pas traîner en clair indéfiniment), révoque la famille, comportement d'avant D36.
- `state == 'revoked'` (vol déjà détecté, suspension, déconnexion explicite) : révoque
  immédiatement, **jamais** de fenêtre de grâce — ce n'est pas le même scénario qu'une rotation
  naturelle interrompue par le réseau.

**L'écart signalé — `amoa/questions/L1-02.md`.** Renvoyer le même jeton en clair à une seconde
présentation suppose de l'avoir gardé sous une forme récupérable, alors que C-01 décrit le jeton
de renouvellement comme une valeur dont « seul le haché est stocké ». Les deux principes se
contredisent littéralement dès que D36 exige un rejeu bit-à-bit. Retenu : conserver le jeton
remplaçant en clair sur l'enregistrement qui vient d'être remplacé, le temps de la fenêtre
seulement, effacé au premier accès qui la constate dépassée — une dérogation bornée et documentée
dans le `help` du champ, pas silencieuse. L'`accessToken`, lui, n'a pas besoin d'être rejoué à
l'identique (JWT sans état côté serveur) : une réémission fraîche à chaque rejeu ne casse rien et
donne au client une validité pleine. Deux options écartées et pourquoi : détaillées dans le
fichier d'écart. Réserve consignée : aucun nettoyage périodique n'efface `next_raw_token` pour un
jeton jamais représenté après rotation — inerte au-delà de la fenêtre, mais présent en base tant
que personne ne retente ce jeton précis.

**Test pré-existant devenu faux par construction, corrigé plutôt qu'ignoré**
(`test_auth.py::test_refresh_rotates_and_old_refresh_token_becomes_unusable`) : il vérifiait
qu'une réutilisation *immédiate* révoque toujours la famille — exactement le cas que D36 rend
légitime. Réécrit pour vieillir explicitement l'horodatage de rotation d'une heure avant de
rejouer (`rotated_record.write(...)`, `flush_recordset(["rotated_at"])`), donc vérifier le
comportement **au-delà** de la fenêtre plutôt que de dépendre d'un délai de grâce à zéro — une
fenêtre à zéro n'est pas fiable sur deux requêtes HTTP consécutives dans le même worker de test,
`fields.Datetime.now()` étant tronqué à la seconde (précision de stockage) : deux appels dans la
même seconde d'horloge auraient un écart nul, donc « dans » n'importe quelle fenêtre y compris
zéro. Nouveau test complémentaire pour le rejeu dans la fenêtre
(`test_replaying_a_just_rotated_token_within_the_grace_window_replays_the_same_pair`), bout en
bout par vraies requêtes HTTP.

**Critère 3 bis testé aux deux bornes, au niveau modèle** (`test_token.py`, `TransactionCase`,
horodatage manipulé directement plutôt que dépendre du temps réel écoulé) :
`test_reuse_within_the_grace_window_replays_the_same_pair` (9 s sur une fenêtre de 10 s — dans la
fenêtre, couple identique renvoyé, rien révoqué) et
`test_reuse_past_the_grace_window_still_revokes_the_family` (11 s sur une fenêtre de 10 s — hors
fenêtre, famille révoquée, `next_raw_token` effacé). Plus
`test_reusing_an_explicitly_revoked_token_ignores_the_grace_window` (un jeton `revoked` n'a jamais
droit à la fenêtre, même présenté immédiatement).

**Deux pièges trouvés en écrivant ces tests, tous deux déjà documentés ailleurs dans le dépôt mais
retrouvés à la dure plutôt que consultés d'abord — à noter pour la prochaine fois.**

1. **`flush_recordset()` manquant après une écriture manuelle d'horodatage.** Écrire
   `rotated_at` sur un enregistrement puis appeler aussitôt `_rotate()` (qui relit par
   `search()`, une requête SQL) peut lire une valeur non poussée en base dans la même
   transaction — exactement le piège déjà consigné dans `code/docs/odoo-pitfalls.md`
   (« tout code qui s'appuie sur une contrainte au niveau base doit provoquer le vidage avant de
   la déclencher », généralisé ici à toute relecture SQL directe après un `write()`). Corrigé par
   `flush_recordset(["rotated_at"])`, comme `test_routing.py` le fait déjà pour un besoin
   identique.
2. **`self.assertRaises` (TransactionCase) ouvre un savepoint qu'il annule à la sortie.** Un test
   qui observe un *effet secondaire persistant* de l'exception (ici : la révocation de la famille,
   l'effacement de `next_raw_token`) doit utiliser `try`/`except` explicite, pas
   `self.assertRaises` — sans quoi l'assertion suivante voit un état annulé, pas l'état réel.
   **Ce piège était déjà écrit en commentaire** dans ce même fichier, sur
   `test_reusing_a_rotated_token_revokes_the_whole_family`, à quelques lignes du nouveau test qui
   vient de le reproduire à l'identique. Trouvé par un échec confus (« TokenReused not raised »
   sur un appel dont le fait même de tracer pas à pas montrait la bonne exception levée un peu
   plus haut dans la même fonction) plutôt que par la lecture du commentaire voisin — la leçon
   était déjà là, elle n'a pas été relue avant d'écrire le test qui l'a redécouverte.

Vérifié : suite Odoo ciblée (`TestBabanaToken`, `TestAuthRefreshAndLogout`, `TestMeController`,
`TestGoogleAuth`, 28 tests, 0 échec) puis suite complète sur la même base (390 tests, 0 échec).

---

## L3-11 et L6-06

À suivre dans ce même rapport, entrées séparées, dans l'ordre indiqué par la nuit.
