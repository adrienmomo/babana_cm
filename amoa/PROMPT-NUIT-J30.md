# Prompt de lancement — session de nuit J30

**Objectif** : que la démonstration soit jouable dès que le VPS existe.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J28 et J29, D52 contraintes vérifiées, SMTP sans défaut, outil de figuration"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-06.md`.

Deux de tes trois écarts disent la même chose que la semaine dernière : quelque
chose d'écrit qui n'a jamais tourné. C'est le fil de cette nuit.

## Périmètre de cette session

1. **D52** — la contrainte d'unicité manquante, et la vérification systématique
2. **Le SMTP sans valeur par défaut** — application de D43, retournée
3. **L'outil de figuration** — mettre en ligne les chauffeurs du jeu de données
4. **Les deux corrections de L7-04** — la resynchronisation qui dit ce qu'elle
   ignore, l'écran qui affiche un fait plutôt qu'une attente muette

## D52 — la contrainte, et le motif derrière

Corrige l'unicité de l'identifiant public. Et surtout : **compare les
contraintes déclarées dans le module à celles réellement présentes en base**
après installation, mécaniquement.

C'est la deuxième fois qu'une contrainte protège le vide — celle du solde
chauffeur était dans le même cas le 20 août, pour une autre raison. Deux
occurrences, c'est un motif, et rien ne dit qu'il n'y en a pas une troisième.

**Ce qui rend ce défaut particulier** : une contrainte qui échoue silencieusement
ressemble exactement à une contrainte qui protège. Personne ne va vérifier ce
qui est déjà écrit.

Et le corollaire, à chercher ailleurs : **un identifiant unique généré par valeur
par défaut n'est pas unique** sur une table déjà peuplée. Les autres modèles ne
se déclenchent pas aujourd'hui parce que leurs tables sont vides à
l'installation — ce n'est pas une garantie, c'est une coïncidence.

## Le SMTP — D43, dans l'autre sens

`SMTP_HOST=mailpit` est la valeur par défaut du fichier d'exemple, que le
démarrage recopie. Une mise en production qui suit le chemin documenté enverrait
ses factures à un simulateur — **qui les accepte et ne signale rien**.

Ton écart visait le mauvais fichier, mais il avait raison sur le fond, et j'ai
mis un moment à voir pourquoi : c'est D43 retournée. Là, une configuration
absente retombait sur le vrai fournisseur ; ici elle retombe sur le simulateur,
et c'est pire, parce qu'un simulateur répond « envoyé ».

Les réglages qui désignent un fournisseur réel n'ont donc **pas de valeur par
défaut**. Vides dans l'exemple, renseignés explicitement par la configuration de
développement. Cherche s'il y en a d'autres dans le même cas.

## L'outil de figuration

Ton refus des deux raccourcis était juste : un `GEOADD` depuis le jeu de données
violerait D26, un endpoint « pose cette position » créerait un second écrivain.

L'outil met donc en ligne les chauffeurs du jeu de données **par le vrai
chemin** — authentification, connexion, disponibilité, positions — et les fait
se déplacer dans Douala.

**Garde-le, ne le jette pas.** Les nuits de vérification le réécrivent à la main
depuis un mois, et chaque répétition avant le pilote en aura besoin. Des
déplacements plausibles, pas aléatoires (D21) : une moto suit des rues, elle ne
traverse pas le Wouri.

## Les deux corrections de L7-04

**La resynchronisation dit ce qu'elle ignore.** Aujourd'hui elle échoue
entièrement si Odoo est injoignable, et prive le chauffeur d'une proposition
qu'elle connaît pourtant localement. Ton raisonnement — ne pas renvoyer un état
de course trompeur — est juste, mais il manque une troisième voie : porter la
proposition **et** signaler que l'état de la course est indéterminé. Ne pas
inférer d'un silence, et ne pas se taire quand on sait quelque chose.

**L'écran affiche un fait plutôt qu'une attente muette.** Ma consigne — pas de
délai inventé — était juste, et tu l'as bien tenue. Mais il y a une différence
entre inventer un délai pour conclure un fait et dire à l'utilisateur ce qu'on
observe : tu connais l'état de connexion. « Vérification… — hors connexion »
n'invente aucune durée.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, puis `make seed`, puis l'outil de figuration, puis la passe
finale.

**Et joue le scénario du §3 de `amoa/07-demonstration.md` en entier** — c'est la
question que je te posais hier et qui n'a pas encore de réponse. Dis à quelle
étape il bute s'il bute.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J30.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une base fraîche, seedée, cinq chauffeurs qui bougent sur la carte, et le
scénario de démonstration joué de bout en bout.
```

---

## Après cette nuit

La démonstration ne dépendra plus que du VPS et du DNS — deux heures de votre côté.

Restera, en périmètre pilote : les habilitations (L8-01, L8-02 — sous revue humaine, et **aucun
accès ne peut être ouvert sans elles**, y compris au client), le back-office superviseur (L9-01 à
L9-05), le mode dégradé (L6-16), la file de rejeu (L3-12), la facture (L4-06), l'écran de recette
(L5-07), les sauvegardes (L8-08), les scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu
à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone, dont trois dépendances natives dépendent.

**Premières courses visées au 13 octobre, marge au 20** — `amoa/06-jalons-et-pilote.md`.
