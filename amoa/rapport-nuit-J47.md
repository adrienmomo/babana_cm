# Rapport — nuit J47 (4 septembre 2026)

Périmètre : D73, seul sujet — le vivier, instrumenté pendant qu'il défaille (D72).

Lu en entier avant d'écrire du code : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-23.md`,
`amoa/01-architecture.md` §9 quaterdecies (D72, déjà consigné par la revue de J46).

---

## 1. Reproduit du premier coup, par la commande réelle

Méthode de D70, reprise à l'identique : rejouer `npm test` (jamais un fichier isolé) contre la
pile réelle démarrée par `make up`, en boucle jusqu'à ce que le symptôme tombe. Il est tombé dès
la première passe :

```
not ok 5 - select-driver rejoué par un vrai conflit de sérialisation PostgreSQL ne produit qu'une
réservation (L3-17, critère 3)
  error: 'chauffeur(s) [fff450bf-a95a-4d65-a98a-f098b9a66a33] jamais apparu(s) dans nearby.drivers
  après 20000ms'
```

`concurrency/select-driver-replay.test.ts`, itération en cours après 32,6 s. Même message, même
famille que les quatre occurrences de J46.

## 2. Mesuré pendant, pas après

Instrumentation temporaire, posée sur le service réel via le montage de développement (`tsx
watch`, `infra/compose.dev.yaml`), jamais laissée sans preuve avant d'agir (garde-fou du
protocole) : une ligne de journal dans `redis/geo-index.ts::findNearby` (candidats bruts, candidats
frais, cardinalité du pool à cet instant) et dans `tracking/ingest.ts::ingestOne` (résultat de
`addEligibleToPool`). Retirée dès la cause confirmée — `git checkout` sur les trois fichiers de
service touchés, rien n'en reste dans le dépôt.

**Ce que la mesure a montré, sans ambiguïté, pendant toute la fenêtre d'attente de 20 s** :

- `addEligibleToPool driverId=fff450bf-... inserted=true` — il est bien entré dans le pool.
- À **chaque** appel de `findNearby` pendant les 20 s, il apparaît dans les candidats bruts
  (`rawIds`), jamais marqué périmé (`stale=[]` systématiquement) — il n'en est jamais sorti.
- La cardinalité mesurée du pool à ce point : 6 à 7 chauffeurs réellement en ligne, simultanément,
  à la coordonnée exacte (4.05, 9.70).
- Dans chaque liste de candidats bruts, il occupait systématiquement le 6e ou 7e rang — jamais
  dans les 5 premiers que `nearby/handler.ts` retient (`NEARBY_RESULT_LIMIT`, D14).

**Réponse à la question posée par la nuit précédente** : ni jamais entré, ni sorti — **présent,
et jamais projeté**. Ordre des candidats bruts vérifié contre l'ordre lexicographique de leurs
identifiants : correspondance exacte. À distance rigoureusement identique, Redis départage les
scores égaux par ordre du membre, jamais par ordre d'arrivée dans le pool — `fff450bf-...`
commence par deux des caractères hexadécimaux les plus grands, il perdait le départage à chaque
tour, par construction, pas par malchance.

## 3. La cause en amont : quatre fichiers, un seul point, une exécution concurrente jamais vue

D'où venaient 6 à 7 chauffeurs réels au même point exact ? Vérifié, pas supposé : `node --test`
(sous `tsx`) exécute les fichiers qu'il reçoit en processus concurrents — deux fichiers de sonde
d'une poignée de secondes chacun, passés ensemble en ligne de commande, démarrent et terminent à
la même milliseconde. Or `concurrency/ride-transitions.test.ts`, `concurrency/select-driver-
replay.test.ts`, `http-contract/endpoint-coverage.test.ts` et `e2e/full-ride.test.ts` (par
`e2e/fixtures/geo.ts`) hardcodaient **tous** le même point (4.05, 9.70) pour leur(s) chauffeur(s)
de test — sans coordination entre eux, chacun correct pris isolément. C'est leur concurrence,
jamais exercée par un fichier seul (constaté trois nuits de suite, J44 à J46, en isolant le
fichier soupçonné après coup), qui les fait cohabiter et qui a rendu le symptôme invisible à
toute vérification qui isole.

**Ce que ce n'est pas** : ni une violation d'invariant (le pool n'a toujours qu'un seul écrivain,
D26 ; les 5 plus proches restent exactement les 5 plus proches, D14 ne garantit rien de plus à
égalité parfaite), ni un défaut du géo-index ou de la diffusion — les deux se comportent
exactement comme spécifiés, y compris le départage à égalité, qui est un comportement Redis
documenté, pas un bug de ce dépôt. C'est une collision de jeux de données entre suites de test
conçues indépendamment.

## 4. Le correctif, et pourquoi il ne touche aucune règle métier

`concurrency/select-driver-replay.test.ts`, `http-contract/endpoint-coverage.test.ts` et
`e2e/fixtures/geo.ts` reçoivent chacun un point distinct, séparé des trois autres de plus de
12 km — largement au-delà de `NEARBY_MAX_RADIUS_METERS` (5 km, seul rayon que ces fichiers
utilisent ; aucun ne passe `excludeDriverIds`, donc aucun n'exerce l'élargissement par exclusion,
`NEARBY_EXPAND_MAX_RADIUS_METERS` ne les concerne pas — vérifié par une recherche vide dans tout
`test/` avant de choisir la marge). `concurrency/ride-transitions.test.ts` garde (4.05, 9.70).

Vérifié sans effet de bord avant de choisir les nouvelles coordonnées, pas après : le mock de
routage (`services/mocks/maps/src/routing.js`) ne dérive que de la distance entre origine et
destination, jamais des coordonnées absolues (« réponse déterministe... pour toute paire de
points, connue ou non », critère d'acceptation 1 de L0-08) ; une seule zone tarifaire, marquée par
défaut, couvre tout le rectangle opérationnel (`babana_zone_default.xml` — le rectangle englobant
est d'ailleurs exactement `OPERATIONAL_BOUNDS_*`) ; et `action_propose`
(`babana_ride_state.py`) ne vérifie aucune proximité géographique entre un chauffeur et le point
de départ d'une course. Déplacer ces points ne change donc ni un tarif, ni un trajet, ni une règle
métier — seulement la probabilité de collision entre suites concurrentes. Le delta
origine/destination de chaque fichier est préservé à l'identique, pour que la distance (et donc le
tarif simulé) reste inchangée.

**Vérifié à blanc, deux fois, par la commande réelle** : `npm test` rejoué deux fois après le
déplacement (les mêmes globs concurrents qu'avant, rien isolé) — 54/54 tests verts les deux fois,
aucune occurrence du symptôme, `select-driver-replay` et `config-coherence` (qui avait signalé la
variable de débogage laissée par erreur dans une itération intermédiaire, corrigée en retirant
entièrement l'instrumentation) compris.

## 5. Consigné

`amoa/01-architecture.md` §9 quindecies, D73 (table des décisions et section narrative).

Aucun fichier d'écart déposé dans `amoa/questions/` : ni invariant violé, ni spécification
ambiguë ou contradictoire — un défaut de jeu de données de test, diagnostiqué et corrigé dans le
même geste.

---

## Passe de clôture — mise à jour de `amoa/rapport-nuit-J41.md`

Complétée avec cette nuit : la quatrième entrée des tests instables (silence puis dépassement,
J44 à J46) est maintenant fermée avec sa cause racine, pas seulement son mécanisme de blocage. Le
détail de la mise à jour est dans `amoa/rapport-nuit-J41.md` lui-même (§3), pas dupliqué ici.

---

## `make reset`, `make seed`, passe finale

Faite, dans cet ordre, sur l'infrastructure réelle (`make up` déjà debout n'a pas été réutilisé
tel quel) :

- `make reset` : volume Postgres réellement supprimé, pas seulement les conteneurs relevés (même
  discipline que D68, `CLAUDE.md` — « la base de développement est jetable, et doit être jetée
  régulièrement »).
- `make up` : les huit services reviennent sains (`--wait`).
- `make seed` : `== seed babana : OK ==` — zones=6, chauffeurs en ligne=5, courses réglées=8. Un
  avertissement bénin déjà connu (8 envois de facture asynchrones encore en vol après 120 s,
  `invoice_email_state` à « Non envoyée » le temps qu'ils aboutissent) — sans rapport avec cette
  nuit, non nouveau.
- `make test`, en entier, sur cette base neuve : **820 tests Odoo, 0 échec, 0 erreur** (« 0 failed,
  0 error(s) of 820 tests when loading database 'babana' », base fraîche donc sans l'artefact
  documenté par D68/`odoo-pitfalls.md`) ; `test/` (concurrency, auth, http-contract, config,
  storage, e2e) : **54/54** ; générateurs de test (machine à états L4-10, matrice de messages C-02
  critère 5) : OK ; `build-web-bundle.test.sh` : OK ; `test:resilience` (L3-14) : **3/3**. Aucun
  échec nulle part dans la sortie complète (6142 lignes, recherchées pour toute occurrence de
  `fail`/`FAIL`/`ERROR` en dehors du bruit attendu des tests Odoo qui provoquent volontairement une
  contrainte SQL pour vérifier qu'elle tient).
- `make lint`, `make typecheck`, `make secrets-scan` : les trois propres, y compris `tsc -p
  tsconfig.json` du paquet `@babana/concurrency-tests` sur les trois fichiers modifiés cette nuit.

Point 3 de la définition de fini (`make test` en entier, pas seulement les tests de la tâche)
satisfait sur cet état neuf, pas sur l'infrastructure restée debout depuis la veille.
