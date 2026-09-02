# Écart — le jeu de données de démonstration ne peut pas contenir de « positions tenues à jour en direct » (J29)

## Ce que demande le prompt

Le périmètre de J29, §1, liste parmi ce que le jeu de données doit contenir :

> Une poignée de chauffeurs approuvés, avec des noms plausibles, des motos affectées, des
> documents valides, et **des positions dispersées dans la ville**.

Et le scénario de `amoa/07-demonstration.md` §3, étape 1 :

> La carte de Douala, sa position, et cinq chauffeurs autour de lui — **réels, tenus à jour en
> direct**.

## Pourquoi le seed Odoo seul ne peut pas le faire

Une position de chauffeur ne vit **jamais** dans Odoo (invariant 1 : « une écriture Odoo par
événement métier, jamais par tick GPS »). Elle vit dans le pool géo-indexé Redis du service
temps réel, et ce pool **n'a qu'un seul écrivain** : le script Lua d'éligibilité
(`services/realtime/src/redis/pool-eligibility.lua`, frontière D26 vérifiée par le lint —
« Aucun `GEOADD` sur la clé du pool hors du script d'éligibilité »). Ce script n'est déclenché
que par un `position.update` reçu sur une **connexion WebSocket chauffeur authentifiée**, après
un `availability.set { online: true }`.

Autrement dit : rendre un chauffeur visible sur la carte, c'est exactement ce que fait
l'application Chauffeur au démarrage — s'authentifier, ouvrir une connexion, se déclarer en
ligne, émettre sa position. Un `odoo shell` n'a aucun de ces leviers, et il serait faux de lui
en donner un (un `GEOADD` depuis le seed violerait D26 ; un endpoint interne « pose cette
position » créerait un second écrivain du pool).

C'est la même frontière que les nuits de vérification précédentes rencontraient déjà : elles
amenaient un chauffeur en ligne « par un script jetable en WebSocket » (`amoa/rapport-nuit-J20.md`,
`availability.set` / `position.update` / `proposal.accept`), jamais par un raccourci serveur.

## Ce qui a été fait (appliqué cette nuit)

Le seed Odoo (`services/odoo/scripts/seed.py`) crée les chauffeurs **approuvés et `is_online`**,
avec motos, documents vérifiés, affectations — tout ce qui est durable et qui remplit le
back-office.

La partie « en direct » est portée par un **compagnon committé**, pas un script jetable :
`services/realtime/scripts/demo-drivers.mjs`, lancé par `make seed-drivers`. Il ouvre une
connexion WebSocket par chauffeur semé, par le **vrai chemin** (`mock-google-identity` →
`POST /api/v1/auth/google` → WS `?token=` → `availability.set` + `position.update` réguliers),
à des positions dispersées et déterministes (D21) autour d'un centre configurable. Ctrl-C
repasse chacun hors ligne. Aucune écriture Redis directe, aucun raccourci serveur.

Le seul contrat entre les deux fichiers : les chauffeurs de démonstration ont pour `google_sub`
`babana-demo-driver-1` .. `babana-demo-driver-N`.

## En quoi c'est un écart, et pas juste un choix d'implémentation

Le prompt range « positions dispersées » **dans le contenu du jeu de données**, et l'attendu du
matin est « une base fraîche, `make seed`, et un produit qu'on peut montrer sans avoir à créer
quoi que ce soit à la main ». Or après `make seed` seul, la carte est **vide de chauffeurs** :
il faut une seconde commande, `make seed-drivers`, qui doit **rester ouverte** pendant toute la
démonstration (elle tient les connexions). Ce n'est pas « rien à créer à la main », c'est « une
commande de plus à laisser tourner dans un terminal ».

Deux lectures possibles, à trancher :

1. **Retenue cette nuit.** `make seed` = données durables ; `make seed-drivers` = présence
   temps réel, à lancer juste avant la démonstration et à laisser ouvert (comme l'app Chauffeur
   doit rester ouverte — c'est d'ailleurs l'une des trois phrases à dire au client,
   `07-demonstration.md` §4). Documenté dans le `Makefile`, le rapport et le `README` du seed.
2. **Un service de démonstration dans `compose.dev.yaml`.** `demo-drivers.mjs` tournerait comme
   un conteneur de plus (profil `demo`), démarré/arrêté avec la pile. « Rien à lancer à la
   main », au prix d'un service qui simule des chauffeurs mêlé à l'infrastructure — à n'activer
   que derrière un profil explicite, jamais en recette ni en production (même discipline que les
   mocks L0-08).

**Recommandation : garder l'option 1 pour la démonstration de cette semaine** (le plus lisible :
on voit les chauffeurs se connecter, on peut en couper un pour montrer un départ de la liste),
et **ouvrir l'option 2 seulement si un profil `demo` de `compose.dev.yaml` apparaît par
ailleurs utile** (par exemple pour L10-01, les scénarios de bout en bout).

## Urgence

**Non bloquant.** `make seed-drivers` existe, est testé (les cinq chauffeurs entrent bien dans
`babana:drivers:available`), et suffit à la démonstration. La question ne porte que sur
l'emballage : commande à lancer à la main, ou service de la pile.
