# Prompt de lancement — session de nuit J45

**Un seul sujet.** Le symptôme qui revient depuis trois nuits, et que personne n'a encore relié.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J44, D70 -- trois nuits, un seul symptôme du vivier"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-21.md` et
`amoa/01-architecture.md` §9 duodecies.

Ton balayage d'hier n'a rien trouvé, et tu l'as dit explicitement plutôt que de
laisser le silence valoir conclusion. C'est la bonne façon de rendre un
résultat négatif.

## Le sujet de cette nuit, et le seul

**« Chauffeur jamais apparu dans nearby.drivers après 20000 ms », suivi d'un
silence du processus.** Ce message est apparu trois nuits différentes — le 15,
le 19 et le 20 septembre. Chaque fois, une explication d'environnement
plausible a été retenue, et chaque fois elle ne valait que pour son occurrence :

- le 15, une machine mise en veille ;
- le 19, deux exécutions concurrentes contre la même pile — cause réelle,
  identifiée, et c'était toi ;
- le 20, **ni l'une ni l'autre** : une seule exécution vérifiée par `ps`, un
  processus à 0 % de CPU, aucune connexion réseau ouverte, seize minutes de
  silence.

Personne n'avait relié les trois. C'est ma faute, pas la tienne : tes rapports
enregistrent chaque occurrence avec ses observations, et c'est au débrief de les
recouper. Il a mis trois nuits.

**Ce qui change avec le recoupement** : quatre incidents épars sont une nuisance
qu'on tolère ; le même trois fois dans un seul mécanisme est une piste. Et
celui-ci décide si un client voit un chauffeur. En production, un chauffeur qui
n'apparaît pas dans le vivier, c'est quelqu'un qui ouvre l'application et ne
trouve personne.

## Comment je te propose de t'y prendre

**Deux temps, et le second compte plus que le premier.**

**1. Relire à froid le chemin de diffusion**, en cherchant ce qui pourrait ne
pas être libéré : un minuteur qui survit à `unsubscribe`, une connexion Redis
qui reste ouverte après un scénario en échec, un abonnement dont le nettoyage
dépend d'un chemin nominal. L3-20 existe précisément parce que cette classe de
défaut avait déjà été anticipée là — et `nearby.test.ts`, le troisième
incident jamais reproduit, porte sur le compte de minuteurs après
`unsubscribe()`. Ce n'est peut-être pas une coïncidence.

**2. Instrumenter, puis rejouer en boucle jusqu'à reproduire.** C'est le temps
qui compte. Trois lectures précédentes n'ont rien vu ; ce qui manque n'est pas
une hypothèse de plus, c'est **une observation prise pendant que ça se
produit** — et pas dix minutes après, comme tu l'as noté toi-même hier.

Ce que je voudrais voir mesuré au moment du figement, pas après : les
connexions Redis ouvertes, les minuteurs actifs, les abonnements vivants, et ce
que le processus attend. Une boucle qui rejoue `ride-transitions.test.ts` en
continu en enregistrant ces compteurs à chaque passage, jusqu'à ce que le
symptôme tombe dedans.

**Si tu reproduis, tu as gagné la nuit, même sans correctif.** Une observation
du figement en train de se produire vaut mieux qu'une réparation supposée. Et
si tu ne reproduis pas après un nombre honnête de passages, dis-le avec le
nombre : c'est aussi un résultat, et il oriente la suite.

**Et si en instrumentant tu trouves que le figement est dans l'outillage de
test plutôt que dans le service** — un flux bufferisé, un `runner` qui attend
un fichier terminé — c'est une réponse tout aussi bonne, à condition qu'elle
soit prouvée et pas supposée. Elle refermerait le sujet pour de bon.

## Ce que je ne veux pas

Un correctif défensif posé « au cas où » sur le chemin du vivier, sans avoir
reproduit. Ce mécanisme porte la réservation atomique et la règle du seul
écrivain (D26) ; y ajouter une garde non motivée coûterait plus cher que le
symptôme.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J45.md`, et **complète la passe de clôture de J41** — c'est
le document qu'on lira à la reprise.

## Ce que j'attendrai demain matin

Soit une observation du figement prise pendant qu'il se produit, soit un nombre
de passages sans reproduction. Les deux m'intéressent ; une troisième
explication plausible non vérifiée, non.
```

---

## Après cette nuit

**Le périmètre pilote est fini**, celle-ci est une élucidation, pas une tâche neuve.

La suite est dans `amoa/08-passation-pilote.md`. Et le relais SMTP n'a toujours pas commencé —
c'est la plus longue des six démarches, et la seule dont le délai ne dépend pas de vous une fois
lancée.
