# Prompt de lancement — session de nuit J47

**Un seul sujet.** Le vivier, mesuré pendant qu'il défaille.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J46, D71 close, D72 -- la défaillance de diffusion du vivier"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-23.md` et
`amoa/01-architecture.md` §9 quaterdecies.

Hier tu as corrigé ma rédaction avant de l'appliquer. J'avais nommé `callOdoo`
et écrit « les deux seuls » sans nommer le second — et c'est `callOdooOnce` qui
portait le chemin d'acceptation, celui que D71 existait pour protéger. Un
correctif suivant ma phrase à la lettre aurait laissé le vrai chemin silencieux,
avec une décision arbitrée, un test vert, et rien de réparé. Troisième fois que
tu vérifies avant d'obéir.

## Le sujet de cette nuit, et le seul

**« Chauffeur jamais apparu dans nearby.drivers après 20000 ms. »**

Ce n'est plus un test instable, et plus un artefact d'outillage. Ton correctif
de D70 tient : plus aucun figement, chaque suite continue après l'échec. Et une
fois le silence retiré, ce qu'il masquait est apparu plus nettement — **quatre
échecs dans une passe, sur trois fichiers indépendants**, contre une occurrence
isolée jusque-là.

C'est ce qu'il faut attendre en réparant ce qui masque : le défaut devient plus
visible, jamais moins fréquent.

**Ce qui est déjà écarté, pour ne pas y revenir :**

- Le cache de profils chauffeur. Son échec dégrade, il n'exclut jamais (D30,
  écrit après le blocage du 18 août causé par la règle inverse). Tu l'as vérifié
  toi-même hier avant de me le dire, et l'argument est bon.
- Le figement (D70, corrigé).
- Les explications d'environnement : veille, exécutions concurrentes, processus
  bloqué. Chacune a couvert une occurrence, aucune ne couvre celles-ci.

La cause est donc en amont du cache : **géo-index ou diffusion.** Et c'est la
fonction qui décide si un client voit un chauffeur — en production, quelqu'un
qui ouvre l'application et ne trouve personne.

## La méthode — celle qui a fermé D70

Tu l'as trouvée toi-même : **isoler ce qu'on soupçonne détruit la condition qui
produit le défaut.** Ne rejoue pas un fichier seul. Rejoue la commande réelle,
en boucle, jusqu'à ce que ça tombe.

Puis mesure **pendant**, pas après. Ce que je voudrais voir, au moment précis où
un chauffeur n'apparaît pas :

- Ce que contient réellement la clé géo du vivier à cet instant — le chauffeur
  y est-il, avec quelle position, quelle ancienneté ?
- Ce que la diffusion a calculé et envoyé, et à qui.
- Où le chauffeur a disparu entre son `availability.set` et la projection : il
  n'est jamais entré, il en est sorti, ou il y est et n'est pas projeté. Ces
  trois réponses appellent trois corrections différentes, et sans mesure on ne
  peut pas choisir.

**Si tu reproduis et que tu réponds à cette dernière question, la nuit est
gagnée, même sans correctif.**

Et retire le facteur de confusion que tu as signalé hier : **tu peux arrêter la
pile `n8n` pendant tes mesures**, à condition de la redémarrer après. Si le
symptôme persiste machine au repos, la charge externe n'était pas la cause ; s'il
disparaît, c'est une réponse aussi.

## Deux garde-fous

**Ne pose aucune garde défensive sur le chemin du vivier sans avoir reproduit.**
Il porte la réservation atomique et la règle du seul écrivain (D26) ; une garde
non motivée y coûterait plus cher que le symptôme.

**Et si tu conclus que c'est un dépassement de charge sans défaut sous-jacent**,
il faut le prouver, pas l'inférer : montre ce que la diffusion met réellement à
publier sous cette charge, et pourquoi vingt secondes ne suffisent pas. Une
quatrième explication plausible non mesurée ne vaut rien.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J47.md`, et **complète la passe de clôture de J41**.

## Ce que j'attendrai demain matin

Où le chauffeur disparaît entre `availability.set` et la projection — mesuré, pas
supposé. Ou un nombre de passages sans reproduction, machine au repos.
```

---

## Après cette nuit

C'est le dernier défaut ouvert qui touche la fonction centrale du produit. Le reste attend le
terrain.

`amoa/08-passation-pilote.md` porte les six démarches, et **rien de ce qui précède ne les bloque**.
Le relais SMTP est la plus longue et n'a pas commencé.
