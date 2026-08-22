# Prompt de lancement — session de nuit J16

**Objectif** : fermer le parcours Client.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J15, D38 construire n'est pas fonctionner, D39 pas de session web"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-24.md`.

Son §1 porte sur un de mes critères d'acceptation, pas sur ton travail : tu as
trouvé que le bundle web compilait depuis quatre nuits en affichant une page
blanche. C'est la troisième fois qu'un de mes critères vérifie quelque chose
d'adjacent à ce qui compte.

## Périmètre de cette session

**Corrections d'abord.**

1. **L6-07** — l'abonnement reste actif pendant que le client compare : un
   chauffeur pris disparaît avant qu'on le touche, pas après
2. **La règle de lecture des trames** (C-02) — vérifie qu'aucun lecteur, code ou
   fixture, ne prend « la trame suivante » ; tu as déjà corrigé le seul que tu
   avais trouvé, confirme qu'il n'y en a pas d'autre
3. **Le flake** — sérialise l'exécution des tests de `services/realtime` plutôt
   que d'allonger les minuteurs. Quatre fichiers touchés, c'est le moment.

**Puis le lot.**

4. **L3-08** — élargissement du rayon et nouvelle liste de cinq
5. **L6-09** — suivi de course en direct, puis résumé de fin

**Si le lot ne passe pas en entier, arrête-toi après L3-08** et dis-le.

## Sur D38, et ce que j'en attends

Le critère 6 de L6-00 demande désormais qu'on ait **ouvert la page**, pas
qu'elle ait compilé. Tu l'as fait de toi-même cette nuit — c'est cette
vérification-là qui a trouvé les quatre défauts.

Refais-la en fin de session, sur le parcours complet cette fois : accueil,
estimation, attente, suivi, résumé. Et dis dans le rapport ce que tu as vu, pas
seulement que tu as regardé.

Le stub `localStorage` posé pour débloquer la vérification reste provisoire et
condamné par L6-18 — **D39 tranche** : l'export web ne persistera aucune
session, elle vivra en mémoire. Ne construis rien de plus sur ce stub.

## L3-08 — pourquoi elle passe avant le suivi

Ton écart de L6-08 avait raison : sans élargissement, un client dont les cinq
chauffeurs refusent un par un fait cinq allers-retours d'écran avant de revenir
à l'accueil. Correct et honnête, et laborieux.

Deux points.

**L'élargissement ne réintroduit jamais d'attribution automatique** (D11). Il
propose cinq autres chauffeurs, le client choisit toujours. C'est la ligne à ne
pas franchir, et elle est facile à franchir sans y penser quand on cherche à
« aider » le client bloqué.

**Un chauffeur qui vient de refuser cette course n'est pas reproposé** sur le
même tour d'élargissement. Sinon le client revoit exactement la personne qui
vient de dire non.

Et quand il n'y a vraiment plus personne : le dire. Jamais laisser croire qu'une
recherche continue en arrière-plan — tu as déjà appliqué cette règle dans L6-08,
c'est la même ici.

## L6-09 — trois points

**Le suivi consomme ce que le service temps réel diffuse, il ne calcule rien.**
Position du chauffeur, ETA : l'app affiche, elle ne dérive pas. Et l'ETA porte
toujours son facteur de correction non calibré (É8) — pas de fausse précision.

**La coupure réseau est le cas courant.** Un client qui perd le réseau pendant
l'approche doit voir un état sans ambiguïté — « position datée de N secondes »
plutôt qu'un marqueur figé qu'on croit à jour. C'est la même exigence que pour
la limitation de débit : un silence est le pire des retours.

**Le résumé de fin est ce que le client relira en cas de litige.** Montant,
distance, durée, chauffeur. Il doit correspondre exactement à ce qui est écrit
côté serveur — c'est la course qui fait foi, pas ce que l'app a accumulé en
route.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` est dû, et surtout : **la passe finale complète l'est aussi.** Elle
a trouvé une régression de treize tests cette nuit qu'aucune vérification par
tâche n'avait vue.

Lis les spécifications des tâches dépendantes : pour L3-08, lis L3-05 et L3-07 ;
pour L6-09, lis L6-10 et L3-09.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J16.md`, une entrée par tâche, commitée avec elle.

Et la même question, dont les réponses ont été les meilleures sections des deux
derniers rapports : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Un parcours complet, ouvert dans un navigateur : commander, être refusé, voir
cinq autres chauffeurs, en choisir un, suivre son approche, lire le résumé.
```

---

## Après cette nuit

Le parcours Client sera complet, hors historique et factures (L6-10, qui dépend de L4-06).

Resteront les écrans Chauffeur — moins nombreux, plus exigeants, puisqu'on les regarde en
conduisant : bascule en ligne, réception de proposition, course en cours, encaissement, et
l'inscription avec les documents.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et les deux démarches à délai subi : **la validation du plan comptable** et **la vérification
développeur Android**.
