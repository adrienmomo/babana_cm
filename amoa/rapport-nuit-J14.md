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

## D36, L3-11, L6-06

À suivre dans ce même rapport, entrées séparées, dans l'ordre indiqué par la nuit.
