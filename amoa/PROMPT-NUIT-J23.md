# Prompt de lancement — session de nuit J23

**Objectif** : qu'une course soit jouable entièrement des deux côtés.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J22, D49 toute action reçoit une réponse, D50 le flux annonce sa cadence, D51 distance à vide"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-31.md`.

Ton diagnostic de la nuit dernière a démonté ta propre hypothèse de la veille
avec des preuves, puis trouvé une cause meilleure qu'elle. Cette nuit part de
tes deux doutes, qui avaient la même forme.

## Périmètre de cette session

**Correctifs de contrat d'abord.**

1. **D49** — `proposal.accepted` entre au contrat. Les 1500 millisecondes
   devinées disparaissent.
2. **D50** — l'accusé d'abonnement porte la cadence réelle du flux. Les copies
   locales de constantes serveur disparaissent aussi.
3. **D51** — `proposal.new` porte la distance à parcourir à vide jusqu'au
   client.

**Puis le lot.**

4. **L6-13** — course en cours côté chauffeur, lien profond vers Google Maps
   (D12), démarrage et fin de course
5. **L6-14** — confirmation d'encaissement espèces

**Si le lot ne passe pas en entier, arrête-toi après L6-13.**

## Sur les trois correctifs — une seule idée

Tes deux doutes disaient la même chose : **là où une application devine, il
manque un message.** Un délai deviné est toujours trop court ou trop long,
jamais juste, puisque rien ne le calibre.

Applique la règle plus largement que les deux cas trouvés : cherche s'il reste
ailleurs une constante recopiée du serveur, ou un succès inféré d'un silence.
C'est le genre de motif qui se reproduit.

## L6-13 — l'écran que le bouton d'urgence attend

Il existe depuis le 24 août, testé en isolation, avec `getPosition` injecté
précisément pour que cette tâche décide. C'est le moment : rappeler le GPS à
l'instant, ou réutiliser la dernière position déjà en vol. Décide et dis
pourquoi.

Trois points.

**Le lien profond ouvre Google Maps et l'app reste vivante derrière** (D12).
Un chauffeur qui revient dans l'app après avoir navigué doit retrouver sa
course, pas un écran rechargé.

**Démarrage et fin sont des décisions humaines, jamais déduites d'une
position.** C'est l'invariant 1 : le nombre d'écritures d'une course est borné
par le nombre de décisions qu'elle a comportées. Un démarrage automatique parce
que le chauffeur est arrivé serait une écriture décidée par une position.

**Le bouton de fin doit être difficile à toucher par accident** — pas un
dialogue à lire, mais pas non plus au même endroit que le bouton qu'on touche
en roulant.

## L6-14 — le chauffeur confirme, il ne saisit pas

Le montant est celui qui est dû. **Le chauffeur confirme un chiffre, il n'en
déclare pas un** — autoriser une saisie ouvrirait la sous-déclaration, et c'est
écrit dans L4-05 depuis le début.

Et si le plafond d'encaisse est franchi par cet encaissement, l'écran le dit
immédiatement et propose la remise (le chemin existe depuis L6-11) — plutôt que
de laisser le chauffeur découvrir qu'il ne reçoit plus de courses sans savoir
pourquoi. C'est le scénario du contexte terrain : la flotte se vide et personne
ne comprend.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport. Le retour aux branches par
tâche cette nuit est le bon réflexe, garde-le.

`make reset` et la passe finale complète sont dus.

**La vérification navigateur** — et cette fois les deux côtés : un client qui
commande, un chauffeur qui accepte depuis son application, démarre, termine, et
encaisse.

Lis les spécifications des tâches dépendantes : pour L6-13, lis L6-14 et L3-10 ;
pour L6-14, lis L5-07.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J23.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une course menée de bout en bout par deux applications réelles, jusqu'à
l'encaissement — et plus une seule constante de cadence recopiée du serveur.
```

---

## Après cette nuit

Restera, côté Chauffeur : **L6-05** — la capture GPS, la tâche la plus sensible du lot pour la
batterie, et celle qui décidera si un chauffeur garde l'application installée. Puis L6-15
(inscription et documents).

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et trois démarches à délai subi, dont deux commerciales : **la passerelle SMS** (un fournisseur,
deux usages), **la validation du plan comptable** et **la vérification développeur Android**.
