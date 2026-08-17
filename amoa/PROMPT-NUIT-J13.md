# Prompt de lancement — session de nuit J13

**Objectif** : les trois fondations partagées sur lesquelles tous les écrans s'appuieront.

**Dernière nuit sans rien de visible.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J12, L6-00 navigation, D20 reconfirmée"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-21.md`.

Son §5 arbitre le trou que ton rapport a trouvé dans mon découpage : la
navigation n'existait nulle part, et aucune tâche ne la posait. C'est une tâche
maintenant, L6-00, et c'est la première de la nuit.

## Périmètre de cette session

Trois tâches, dans cet ordre.

1. **L6-00** — navigation et arborescence des écrans (tâche nouvelle,
   `amoa/specs/L6-mobile.md`)
2. **L6-03** — client API partagé
3. **L6-04** — client WebSocket partagé

Aucun écran métier. Ces trois-là portent ce sur quoi les quinze écrans du lot
vont s'appuyer ; en écrire un avant serait le réécrire après.

## L6-00 — trois points sur lesquels je ne transige pas

**La compatibilité web se vérifie avant d'adopter la bibliothèque, pas après.**
D22 n'est pas négociable, et le découvrir à L6-18 coûterait une réécriture
complète. Une compilation web réussie fait partie des critères d'acceptation,
pas une confiance dans la documentation de la bibliothèque.

**La garde d'authentification vit dans l'arborescence, jamais dans les écrans.**
Si chaque écran porte sa propre vérification, le quinzième l'oubliera. Et la
perte de session en cours d'usage — `onSessionLost`, que tu as posé hier —
ramène à la connexion depuis n'importe où, sans que chaque écran s'en occupe.

**Les deux arborescences ne sont pas symétriques, et ne cherche pas à les
rendre telles.** Le Client parcourt une séquence — accueil, estimation,
attente, suivi, résumé. Le Chauffeur vit sur un écran permanent que des
événements interrompent : une proposition arrive, une course commence. Ce qui
se partage, ce sont les types de routes et la garde d'authentification, pas la
forme de l'arborescence.

Le piège de la tâche est le bouton retour d'Android : un retour depuis le suivi
de course ne doit pas ramener à l'écran d'estimation d'une course déjà
commandée. Distingue ce qui s'empile de ce qui remplace.

## L6-03 et L6-04 — points d'attention

**L6-03 généralise ce que tu as commencé hier.** `withTransparentRefresh`
couvre le renouvellement ; il reste la gestion d'erreurs métier et la
temporisation croissante. Garde le principe que tu as posé : l'appelant reçoit
toujours un code du catalogue C-01, jamais une erreur de transport déguisée.

**Chaque code du catalogue a une phrase en français** compréhensible par
quelqu'un qui n'a jamais utilisé d'application de transport (D20, exigence non
esthétique). C'est dans cette tâche que ça se fait, pas dans les écrans — un
message d'erreur écrit quinze fois est écrit quinze fois différemment.

**L6-04, le réseau intermittent est le cas courant, pas le cas limite.** File
d'attente locale, rejeu idempotent, rattrapage d'état à la reconnexion. Une app
qui suppose une connexion stable est inutilisable à Douala. Et l'état affiché
ne doit jamais être ambigu : « hors ligne » et « en attente de confirmation »
ne sont pas la même chose pour un chauffeur qui vient d'accepter une course.

**Le jeton du WebSocket** est le même que celui de l'API, et sa forme est un
contrat (D23). Le service temps réel ferme la connexion avec un code distinct
selon que le jeton est invalide ou expiré (L3-01) — le client doit renouveler
et se reconnecter dans un cas, ré-authentifier entièrement dans l'autre.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

Ces trois tâches ne touchent pas Odoo ; `make reset` n'est pas dû, mais dis-le
dans le rapport plutôt que de le passer sous silence.

Lis les spécifications des tâches dépendantes : pour L6-00, lis L6-06 et L6-15 ;
pour L6-04, lis L6-16 (mode dégradé) et L3-11.

**Trois nouvelles dépendances ont été ajoutées hier.** Si celles de cette nuit
s'accumulent, dis-le : chaque paquet est une surface à maintenir, et une
application mobile lourde tient moins longtemps sur une batterie d'entrée de
gamme.

## Rapport

`amoa/rapport-nuit-J13.md`, une entrée par tâche, commitée avec elle.

Et comme hier, une observation que je ne peux pas déduire du code : **une fois
ces trois tâches posées, qu'est-ce qui reste à écrire pour l'écran d'accueil
Client (L6-06) ?** Pas une estimation en heures — la liste de ce qu'il devra
faire lui-même, une fois qu'il aura la navigation, le client API et la carte.

## Ce que j'attendrai demain matin

Deux applications qui démarrent sur une vraie arborescence, où l'on ne peut
atteindre aucun écran métier sans session, et qui se compilent toutes les deux
— dont le Client pour le web.
```

---

## Après cette nuit

Les fondations du lot L6 seront complètes, et les écrans pourront s'enchaîner : L6-06 (accueil
Client avec carte), L6-07 (estimation), L6-11 et L6-12 côté Chauffeur.

**C'est à partir de là que le produit devient regardable**, et donc testable autrement que par une
suite de tests — sur un téléphone, ou dans un navigateur pour le Client (D22), sans attendre aucun
compte externe.

Resteront côté serveur : L3-12 (la file de rejeu), L4-06 (la facture), et la seconde moitié du lot
temps réel.

Et deux démarches à délai subi, toujours ouvertes :

- **La validation du plan comptable** — trois questions à poser, dont la distinction entre une
  retenue sur salaire et un abandon de créance, et la TVA.
- **La vérification développeur Android**, plutôt que le compte Play.
