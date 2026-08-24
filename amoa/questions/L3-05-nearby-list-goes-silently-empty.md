# Écart — la liste `nearby.drivers` de l'app se vide silencieusement, sans rejet ni erreur visible (24 août 2026)

Trouvé en vérifiant L8-03/L8-04 dans un vrai navigateur, pas dans le périmètre de cette nuit (aucune
tâche de ce soir ne touche `nearby/*`, `HomeScreen.tsx`, `QuoteScreen.tsx`, ni
`@babana/api-client/realtime/connection.ts`) — root-causé avant d'écrire cette entrée, pas
seulement observé, conformément au protocole.

## Constaté

Parcours réel (`http://verify.localhost:8888`, montage à une seule origine, D46) : session client
réelle, chauffeur réel mis en ligne et positionné par le chemin réel (WebSocket,
`availability.set`/`position.update`, confirmé présent dans `babana:drivers:available` tout du
long). Sur un rechargement frais, sélectionner Akwa comme départ affiche parfois le chauffeur
immédiatement (`nearby.drivers` reçu, carte affichée) — et une fois, le parcours complet a été
observé jusqu'à `WaitingScreen` avec une vraie proposition (`proposal.new` reçue côté chauffeur en
temps réel, montant, distance, compte à rebours réels).

Mais à plusieurs reprises, dans la même fenêtre d'onglet, la liste redevient vide (« Aucun
chauffeur disponible pour l'instant ») **sans qu'aucun événement explicable ne l'annonce** :
- Le chauffeur reste présent dans `babana:drivers:available` (vérifié à chaque fois, Redis à
  l'appui) -- ce n'est jamais une vraie absence de chauffeur.
- Une connexion WebSocket **fraîche**, ouverte au même instant depuis la **même page** (même
  origine, même jeton de session, injectée dans la console du navigateur), reçoit
  `nearby.subscribe.ack` `{accepted:true}` puis `nearby.drivers` avec le chauffeur, **à chaque
  essai, sans exception** -- reproduit quatre fois de suite, toujours positif.
- Aucune trace de rejet : ni `nearby.subscribe.ack` `{accepted:false}` (limitation de débit,
  L3-05 C2b), ni fermeture de connexion (`onclose`), ni erreur (`onerror`), ni métrique
  `realtime.invalid_message` (`@babana/api-client/realtime/handlers.ts`, qui journalise tout
  message rejeté par son schéma) dans la console.

**Ce n'est donc ni le service temps réel, ni Redis, ni le chauffeur.** La seule inconnue commune
aux échecs est la connexion WebSocket **de longue durée** que l'app maintient depuis son propre
montage (`realtime.ts::realtimeClient`, ouverte une seule fois par session,
`ensureRealtimeConnected()`), par opposition à une connexion neuve à chaque essai côté diagnostic.

## Ce qui a été éliminé, pas seulement supposé

- **Limitation de débit (L3-05 C2b, 10 abonnements / 60 s)** : envisagée en premier (précédent
  connu, `amoa/rapport-nuit-J17.md`). Écartée : une sonde brute utilisant le **même compte**, donc
  soumise à la **même limite**, reçoit `{accepted:true}` à l'instant précis où l'app affiche déjà
  la liste vide.
- **Chauffeur réellement sorti du pool** (TTL de position expiré, déconnexion) : écarté, vérifié
  directement dans Redis à chaque échec.
- **Mauvaise sélection de coordonnées côté app** (fautes de frappe, mauvais point) : écarté --
  l'app envoie exactement le point choisi (`Départ : Akwa` affiché correctement), et le même point
  interrogé en sonde brute retrouve le chauffeur.

## Un déclencheur précis, isolé en répétant l'essai

En ralentissant le parcours pas à pas (capture d'écran après chaque étape) : la liste s'éteint
**quelques secondes après un abonnement par ailleurs réussi**, sans la moindre interaction
supplémentaire de mon côté -- un essai a laissé le départ posé (Akwa, chauffeur affiché) sans
toucher à l'arrivée, et la liste était déjà vide cinq secondes plus tard. Ce délai correspond à
`NEARBY_BROADCAST_INTERVAL_SECONDS` (5 s par défaut, `config.ts`) : le **premier** envoi de
`nearby.drivers`, immédiat à l'abonnement (`nearby/handler.ts::subscribe`, `push()` appelé une
fois avant d'armer le minuteur), arrive toujours correctement -- c'est la **diffusion périodique
suivante**, sur ce même minuteur, qui semble ne jamais atteindre la connexion de longue durée de
l'app, sans fermeture ni erreur.

Hypothèse la plus cohérente avec cette temporisation précise, non confirmée faute de temps ce
soir : un problème dans la boucle `setInterval` de diffusion elle-même pour cette connexion (une
exception avalée silencieusement dans le callback périodique, qui l'empêcherait de se réarmer,
sans jamais toucher au minuteur du **premier** push, hors boucle) -- plutôt qu'un problème de
transport WebSocket, puisqu'une nouvelle connexion, elle, reçoit toujours son premier push
correctement à chaque essai.

## Pourquoi c'est plus sérieux qu'une gêne de vérification

`TrackingScreen.tsx` (L6-09) maintient exactement le même patron de connexion longue durée pour
`ride.track` -- si l'hypothèse ci-dessus est la bonne, un client en train de suivre une vraie
course pourrait voir la position de son chauffeur se figer silencieusement après plusieurs
minutes, sans bannière de déconnexion (`disconnected` n'est vrai que si `connectionState !==
'connected'`, précisément l'état qui ne change jamais dans ce scénario). C'est un risque pour un
parcours réel, pas seulement pour un banc de vérification.

## Pas allé plus loin

Diagnostiquer la cause exacte (Caddy ? le serveur WebSocket lui-même ? un comportement spécifique
à l'environnement d'automatisation navigateur utilisé ce soir ?) exigerait d'instrumenter le
service temps réel en profondeur ou de reproduire hors de ce banc --  hors du périmètre d'une nuit
qui ne le nomme pas, et le risque (une connexion temps réel silencieusement muette) touche un
mécanisme central (L3-05/L3-09), pas un point isolé.

## Conséquence pour la vérification de ce soir

Le parcours complet « carte jusqu'au résumé de fin » n'a pas pu être bouclé de bout en bout dans
un navigateur ce soir à cause de cette flakiness, malgré plusieurs tentatives. Ce qui A été prouvé
en direct, dans un vrai navigateur : session réelle, `HomeScreen` avec chauffeur réellement
affiché, sélection réelle d'un chauffeur, réservation atomique réelle, **une vraie proposition
reçue côté chauffeur avec compte à rebours réel côté client** (`WaitingScreen`). L8-03 et L8-04
sont par ailleurs prouvés de bout en bout côté serveur, contre le vrai Odoo, par
`test/http-contract/endpoint-coverage.test.ts` (critère 6 de C-01) -- un vrai `fetch`, un vrai
schéma de réponse validé, pas une réponse fabriquée par le test.

## Proposition

Une tâche dédiée à la robustesse de la connexion temps réel côté app : détection de silence de
diffusion (un `ping`/`pong` applicatif, ou un minuteur qui force une reconnexion si aucun message
n'est reçu au-delà d'un délai attendu), pas seulement `onclose`/`onerror`. Candidat naturel :
L6-04 (le client temps réel lui-même) ou une tâche de durcissement dédiée, avec revue humaine
compte tenu de ce que ça touche (L3-05, L3-09, tout écran qui dépend d'un flux continu).
