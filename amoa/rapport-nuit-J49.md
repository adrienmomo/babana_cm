# Rapport — nuit J49 (5 septembre 2026)

Périmètre : D75 (plusieurs émetteurs de jeton, choisis par le jeton) et D76 (le test de
tarification qui dépend de l'heure). La dernière avant la recette `babana.dev`.

Lu en entier avant d'écrire du code : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-26.md`,
`amoa/01-architecture.md` §9 septdecies.

---

## 1. D75 — le jeton porte déjà la réponse

**Vérifié plutôt que supposé, comme demandé** : ce que `mock-google-identity`
(`services/mocks/google-identity/src/index.js`) déclarait réellement comme émetteur par défaut
avant ce soir. Réponse : `https://accounts.google.com` — l'émetteur du **vrai** Google, pas une
valeur distincte. C'était nécessaire tant que `GOOGLE_JWKS_URL` n'avait qu'une seule adresse à la
fois (le jeton devait déclarer l'émetteur que la vérification attendait) ; c'est exactement ce qui
aurait rendu le routage par émetteur inopérant tel quel — deux émetteurs identiques ne routent vers
rien de distinct. Première pièce du soir, donc : donner au simulateur son **propre** émetteur
(`https://mock-google-identity.invalid`, constante fixe des deux côtés, comme `GOOGLE_ISSUERS`
l'était déjà pour le vrai Google — pas une adresse, l'invariant 5 ne s'y applique pas).

**Le routage lui-même** (`services/odoo/addons/babana/services/google_identity.py`) :

- `verify_google_id_token` lit désormais l'émetteur (`iss`) par un décodage non vérifié
  (`jwt.decode(..., options={"verify_signature": False})`), au même titre que la lecture du `kid`
  dans l'en-tête juste au-dessus — cette lecture ne sert qu'à choisir *quelle* clé publique
  vérifier la signature contre, jamais à faire confiance au contenu ; `claims["iss"]` est revérifié
  après coup, sur le résultat dont la signature vient d'être validée.
- `_jwks_url_for_issuer` route vers `GOOGLE_JWKS_URL` pour les deux formes de l'émetteur Google réel
  (inchangé, D43 : absente, elle lève toujours `RuntimeError`, aucun repli implicite), et vers
  `GOOGLE_JWKS_URL_MOCK` pour l'émetteur simulé — **seulement si cette variable est configurée**.
  Un émetteur simulé sans `GOOGLE_JWKS_URL_MOCK` configurée, ou tout émetteur tiers, lève
  `InvalidGoogleToken` : indistinguable d'un jeton invalide ordinaire, comme le catalogue d'erreurs
  l'exige déjà (une seule réponse `INVALID_GOOGLE_TOKEN`, jamais la raison précise).
- **Le cache JWKS est passé d'un singleton à un cache par adresse** (`_jwks_caches`, un
  dictionnaire verrouillé) : deux émetteurs actifs dans le même worker ne doivent jamais s'expirer
  mutuellement le cache l'un de l'autre — sinon router vers l'un puis l'autre à chaque appel aurait
  redéclenché une requête sortante à chaque fois, ce que le critère d'acceptation 7 de L1-01
  interdit précisément. Testé isolément (`test_two_urls_get_independent_caches_neither_
  refetches_the_other`) : deux URL, une seule requête sortante par URL même en alternant.

**Le garde-fou, vérifié comme la moitié importante** : `TestJwksRouting.test_mock_issuer_
rejected_when_mock_jwks_url_is_not_configured` — le test qui compte, celui qui doit échouer : un
jeton dont l'émetteur est le simulateur, présenté à une configuration où `GOOGLE_JWKS_URL_MOCK` est
absente (exactement la configuration qu'un déploiement de production impose), est rejeté. Pas
seulement vérifié qu'un jeton valide passe quand la variable est présente
(`test_mock_issuer_routes_to_mock_jwks_url_when_configured`, qui prouve aussi la coexistence :
`GOOGLE_JWKS_URL` vers le vrai Google et `GOOGLE_JWKS_URL_MOCK` vers le simulateur, résolues
correctement en même temps par le même appel).

**`infra/production/deploy.sh`** refuse désormais un déploiement de production qui listerait
`GOOGLE_JWKS_URL_MOCK`, quelle que soit sa valeur — garde inverse aux autres de ce script (vide =
refusé partout ailleurs ; ici, présente = refusée, absente = seule configuration correcte).

**La démonstration que ceci existe pour rendre possible** : `infra/compose.dev.yaml` ne fige plus
`GOOGLE_JWKS_URL` sur le simulateur — elle y retombe par défaut (`make up` continue de fonctionner
sans aucun compte externe, D19), mais `infra/env/.env` peut la remplacer par la vraie adresse
Google pour une démonstration, sans plus jamais éditer un fichier suivi pour y arriver (c'était le
geste que J48 avait dû faire et défaire). `GOOGLE_JWKS_URL_MOCK`, elle, reste fixée dans
`compose.dev.yaml` : le simulateur n'a qu'une seule adresse possible en développement, rien à
choisir.

Fichiers : `services/odoo/addons/babana/services/google_identity.py`,
`services/odoo/addons/babana/services/routing.py` (commentaire, nom de fonction renommé),
`services/odoo/addons/babana/tests/test_google_identity.py`,
`services/mocks/google-identity/src/index.js`, `infra/compose.yaml`, `infra/compose.dev.yaml`,
`infra/env/.env.example`, `infra/env/.env` (non suivi), `infra/env/README.md`,
`infra/production/deploy.sh`, `code/docs/operations/production.md`, `services/mocks/README.md`.

## 2. D76 — le test qui dépend de l'heure, et le balayage demandé

`test_weekday_mask_restricts_applicability` construisait un « lundi » depuis `datetime.now()` sans
fixer l'heure du jour ; `_find_applicable_rule` convertit cet instant en heure locale de Douala
(UTC+1) avant de lire le jour de semaine, et entre 23h et minuit UTC cette conversion fait
franchir minuit — un « lundi » du test devenait un mardi côté code. Corrigé en fixant l'instant à
midi, **en heure locale d'exploitation** (`_operating_timezone()`, pas une constante UTC+1 codée en
dur dans le test) plutôt qu'à midi UTC comme le proposait `amoa/questions/L2-01-weekday-mask-
midnight-boundary.md` : la date reste calculée depuis aujourd'hui (`active_from` de la règle vaut
`fields.Date.today()` à la création, une date fixe finirait par tomber avant elle), seule l'heure
du jour est fixée, loin des deux bords quel que soit le fuseau d'exploitation configuré.

**Balayage des autres constructions de date depuis `now()` dans les lots sensibles, comme
demandé.** Cherché `.weekday()` dans tout le module `babana` (une seule autre occurrence, dans le
code de production lui-même, correcte) et chaque fichier de test appelant `datetime.now()` /
`date.today()` / `fields.Date.today()` / `fields.Datetime.now()` (neuf fichiers). Deux catégories
sans risque, aucune ne partage la cause du défaut :

- **Aucune conversion de fuseau appliquée** (`test_fare_rule_backoffice.py`,
  `test_motorcycle_backoffice.py`, `test_driver_backoffice.py`) : `date.today()` compté contre
  `fields.Date.today()` côté modèle — les deux lisent la même horloge UTC nue, sans passage par
  `_operating_timezone()`. Rien à convertir, rien à faire franchir minuit.
- **Aucune extraction de jour civil ou de jour de semaine** (`test_auth.py`, `test_ride_backoffice.
  py`, `test_ride_share.py`, `test_routing.py`) : `fields.Datetime.now()` sert à horodater un
  enregistrement ou faire expirer un cache, jamais à déterminer « quel jour » au sens calendaire.
- **`test_driver.py`** fige déjà `odoo.fields.Date.context_today` à une date arbitraire (mock
  direct) — construit précisément pour ne dépendre de rien, le motif inverse du défaut.

Recherché aussi côté TypeScript (`getDay()`, `getUTCDay()`, `weekday`) dans `packages/`, `apps/`,
`test/` : aucune occurrence. **Résultat du balayage : aucune autre occurrence de ce motif dans ce
dépôt** — comme le 21 septembre pour un balayage comparable, c'est un résultat, pas une absence de
recherche.

Fichiers : `services/odoo/addons/babana/tests/test_fare_rule.py`.

---

## 3. `make reset`, `make up`, `make seed`, `make test`, `make lint`, `tsc --noEmit`, secrets-scan,
   smoke-test

Dans cet ordre, sur l'infrastructure réelle, base entièrement vidée (`make reset` avec les
volumes) :

- `make up` : neuf services sains (`--wait`).
- `make seed` : `== seed babana : OK ==` — zones=6, chauffeurs en ligne=5, courses réglées=8.
- Vérifié à la main que `mock-google-identity` déclare désormais bien son propre émetteur
  (`POST /token` sans `iss` explicite → `https://mock-google-identity.invalid` dans le jeton
  décodé), avant de lancer la suite.
- `make test`, en entier, un seul passage : **0 échec**, y compris les huit nouveaux tests de
  `TestJwksRouting`/`TestJwksCache` (D75) et `test_weekday_mask_restricts_applicability` (D76,
  aucune dépendance à la fenêtre UTC cette fois — vérifié en le relisant, pas en le rejouant à
  l'heure du défaut, qui n'était pas celle de cette exécution). Odoo, `npm test` (tous les
  paquets), `test:resilience` (L3-14, isolé comme documenté) : tous verts.
- `npm run lint --workspaces --if-present` : propre, aucun avertissement.
- `npm run typecheck --workspaces --if-present` : propre, neuf espaces de travail vérifiés.
- `tools/secret-scan/scan.sh` : aucun secret détecté dans les fichiers suivis.
- `infra/smoke-test.sh` : tout vert (critères 2/5/6 de L0-01).

Point 3 de la définition de fini satisfait sur cet état neuf.

---

## Passe de clôture — mise à jour de `amoa/rapport-nuit-J41.md`

Ajouté une entrée fermant le doute que J48 avait documenté dans son propre rapport (§6 et « ce qui
laisse un doute ») sans encore le porter dans la passe de clôture elle-même : la source unique de
`GOOGLE_JWKS_URL` empêchant une vraie connexion Google et des chauffeurs simulés de coexister est
désormais résolue par D75, vérifié par les tests de routage et par une vérification directe du
jeton émis par le simulateur. Voir la nouvelle entrée dans `amoa/rapport-nuit-J41.md` §3.

---

## Ce qui laisse un doute pour quelqu'un de réel

**Je n'ai vérifié la coexistence qu'au niveau du routage (`_jwks_url_for_issuer`), pas encore par
un vrai navigateur.** Les tests prouvent que `GOOGLE_JWKS_URL` (vrai Google) et
`GOOGLE_JWKS_URL_MOCK` (simulateur) résolvent correctement en même temps pour n'importe quel appel
de vérification — mais je n'ai pas, cette nuit, ouvert un navigateur pour faire aboutir une vraie
connexion Google pendant qu'un script de chauffeurs simulés tournait en parallèle (le prompt le
demande pour « demain matin », pas pour cette nuit — aucun identifiant Google réel déposé dans
`infra/env/.env` de cette machine, et ce n'était pas dans le périmètre annoncé). Ce que j'ai prouvé
: le mécanisme qui rend cette démonstration possible fonctionne, isolément, dans les deux sens, y
compris le sens qui doit échouer. Ce que je n'ai pas prouvé : que le geste complet, à l'écran, dans
un vrai navigateur, avec un vrai compte Google et `make seed-drivers` en même temps, produit
exactement ce que D75 promet. Le doute est là parce que la dernière pièce — le navigateur — reste
toujours la plus chère à vérifier depuis cette machine, et la seule des deux moitiés de D75 que je
n'ai pas vue de mes yeux.

**Le nom de l'émetteur simulé (`https://mock-google-identity.invalid`) est dupliqué en dur dans
deux fichiers, deux langages** (`google_identity.py::MOCK_GOOGLE_ISSUER`,
`services/mocks/google-identity/src/index.js::MOCK_ISS`), avec un commentaire de chaque côté
disant à l'autre de rester identique. C'est le même choix que `GOOGLE_ISSUERS` pour le vrai Google
(déjà dupliqué de fait entre ce module et la connaissance générale de ce qu'est l'émetteur Google),
mais une désynchronisation future entre les deux fichiers ne serait détectée que par un test qui
échoue au moment où quelqu'un le modifierait d'un seul côté — ce test existe
(`test_mock_issuer_routes_to_mock_jwks_url_when_configured` échouerait), mais il faudrait
comprendre pourquoi il échoue plutôt que le voir annoncé directement.
