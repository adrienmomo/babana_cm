# Prompt de lancement — session de nuit J17

**Objectif** : réparer la commande de course, puis ouvrir la voie au suivi.

**Rien d'autre ne compte tant que commander une course échoue.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J16, D40 dates en UTC suffixé, D41 immatriculation à l'affectation"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-25.md`.

Ton écart `C-01.md` a trouvé que commander une course ne fonctionne pas — sur
la vraie pile, pas seulement en web. Tu as eu raison de ne pas le réparer à
trois heures du matin sur un chemin partagé par toutes les écritures. C'est la
première tâche de cette nuit.

## Périmètre de cette session

1. **C-01R** — les trois défauts enchaînés, plus la suite de conformité qui
   manquait
2. **L'extension de contrat** que L6-09 attend (D41 et le détail décomposé)
3. **L3-09** — diffusion du suivi côté serveur

**Si le lot ne passe pas en entier, arrête-toi après l'extension de contrat.**

## C-01R — les quatre pièces

**1. Les dates.** Odoo écrit de l'UTC suffixé, par **un sérialiseur unique** —
jamais une conversion recopiée dans chaque contrôleur, cette divergence-là ne se
voit pas à la lecture. Cartographie d'abord tous les endroits où une date part
vers le contrat, comme tu le proposais, avant de toucher quoi que ce soit.

Je n'assouplis pas le schéma, et la raison vaut plus que le verdict : une date
sans fuseau n'est pas ambiguë, elle est **fausse d'une heure à Douala**. Un
navigateur lit une date nue comme une heure locale, et l'heure locale y est en
avance d'une heure sur UTC. Assouplir aurait fait disparaître le message
d'erreur en gardant l'erreur — muette.

**2. La classification du rejeu.** Une exception de validation de réponse n'est
pas une erreur réseau. Ne rejoue que sur un `fetch` qui a levé ou un statut ≥
500. Nécessaire quoi qu'il arrive : sans ça, tout futur défaut de schéma
continuera de rejouer des écritures à l'aveugle.

**3. Le rejeu par idempotence côté Odoo**, qui répond 500 au lieu de la réponse
en cache. Défaut distinct, révélé par le premier. Diagnostique avant de
corriger — et regarde si d'autres endpoints d'écriture ont le même trou : celui
de `select-driver` a été prouvé par L3-17, celui-ci ne l'avait jamais été.

**4. La suite qui manquait — c'est la pièce la plus importante.** Critère 6 de
C-01 : chaque endpoint appelé contre le vrai Odoo, sa réponse validée par son
**propre schéma de réponse**. Pas une réponse fabriquée par le test.

La liste des endpoints se dérive du contrat, jamais tenue à la main : un
endpoint ajouté sans son test doit faire échouer la suite, comme la machine à
états le fait déjà.

Ton propre §« pourquoi aucune suite ne l'a vu » est le cahier des charges de
cette suite. Trois suites vertes, et aucune n'exerçait le seul assemblage qui
compte.

**Puis revalide dans un navigateur, jusqu'au bout cette fois** — commander,
être refusé, voir cinq autres chauffeurs par l'élargissement que L3-08 vient
d'ajouter, en choisir un. Et dis ce que tu as vu, pas seulement que tu as
regardé.

## L'extension de contrat

**D41** : `ride.assigned` porte prénom, photo, gamme et **immatriculation**.
Rien ne change avant l'affectation — la flotte reste non balayable (C2b). Ton
observation était juste : c'est le choix qui fait basculer la règle, la même
donnée n'a pas la même sensibilité avant et après un engagement.

**`ride.completed` porte le détail décomposé**, pas seulement le montant. Le
résumé de fin est ce qu'un client relira en cas de litige.

## L3-09 — deux points

**Vérifier à chaque diffusion, pas seulement à l'abonnement**, qu'un client suit
une course qui est la sienne. Tu l'avais relevé toi-même en lisant la
spécification.

**La fréquence de diffusion est découplée de l'ingestion.** Un chauffeur qui
émet toutes les deux secondes ne doit pas produire une diffusion toutes les deux
secondes vers un client dont le forfait de données est compté.

Et la précision réelle ici, pas l'arrondi de L3-05 : le client suit **son**
chauffeur, l'anonymisation n'a plus d'objet.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` est dû, et la passe finale complète aussi — elle a trouvé une
régression de treize tests il y a deux nuits.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J17.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Une course commandée depuis un navigateur, jusqu'à l'écran d'attente, sans une
seule erreur. Et une suite qui échouerait si Odoo se remettait à écrire une date
sans fuseau.
```

---

## Après cette nuit

L6-09 pourra s'écrire sans hypothèse : le contrat portera ce qu'il lui faut, et le serveur
diffusera ce qu'il affichera. Restera ensuite le lot Chauffeur — moins d'écrans, plus exigeants.

Et deux tâches que L6-09 suppose et qui n'existent pas : **L8-03** (partage de trajet) et **L8-04**
(bouton d'urgence). Tant qu'elles manquent, ces boutons seront absents plutôt qu'inertes — mais
elles sont désormais sur le chemin critique du parcours Client, ce qu'elles n'étaient pas dans mon
découpage d'origine.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et toujours, à délai subi : **la validation du plan comptable** et **la vérification développeur
Android**.
