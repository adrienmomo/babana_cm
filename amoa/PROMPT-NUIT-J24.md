# Prompt de lancement — session de nuit J24

**Objectif** : une fin de course honnête, et la capture qui décide si un chauffeur garde
l'application.

**Première nuit du périmètre pilote.** Douze restent après celle-ci.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J23, la fin de course ne porte que la décision, jalons et date de pilote"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-01.md`.

Ton écart de L6-13 a trouvé une contradiction entre deux documents que j'ai
écrits : le contrat demande à l'app un relevé de trajet, et L4-04 dit que c'est
le service temps réel qui le fournit. C'est le premier point de cette nuit.

## Périmètre de cette session

**Correctifs de contrat d'abord.**

1. **La fin de course ne porte que la décision** — `POST /rides/{id}/complete`
   perd `distanceMeters` et `polyline`. L'app dit « terminée », rien d'autre.
2. **La réponse d'encaissement dit ce qui s'est passé** — franchissement du
   plafond et marge restante dans `SettleRideResponse`. L'écran n'infère plus.

**Puis le lot.**

3. **L3-10** — accumulation de la distance et de la durée dans Redis
4. **L6-05** — capture GPS chauffeur

**Si le lot ne passe pas en entier, arrête-toi après L3-10.**

## Sur la fin de course

Ton stopgap était soigné, et la ligne droite « disait » honnêtement que rien
n'avait été relevé. Mais elle ne le dit qu'à quelqu'un qui a lu ton commentaire :
le client, lui, verra un tracé sur son résumé de fin — celui qu'il relira en cas
de litige.

**Quand rien n'a été mesuré : aucun tracé.** Pas une ligne droite, pas un
itinéraire de référence déguisé. C'est D30 et D43, appliqués ici : une absence
explicite plutôt qu'une valeur plausible et fausse.

Odoo lit distance et tracé depuis l'accumulation (L3-10, tâche suivante de cette
nuit) — c'est ce que L4-04 disait déjà.

## L3-10 — l'invariant 1 est en jeu

**Rien de ce que tu accumules n'écrit dans Odoo.** Distance, durée, tracé vivent
dans Redis pendant la course, et ne rejoignent Odoo qu'au moment de la fin de
course — une écriture, à une décision humaine. C'est l'invariant 1, et cette
tâche est exactement celle où on serait tenté de le perdre.

Et le tracé accumulé doit rester exploitable après un redémarrage du service
(L3-14 le testera) : une course en cours ne se perd pas parce qu'un processus
est tombé.

## L6-05 — la tâche qui décide si un chauffeur garde l'application

C'est la plus sensible du lot mobile, et pas pour des raisons de code.

**Un chauffeur dont la batterie tient trois heures désinstalle l'application, et
la flotte se vide sans que personne comprenne pourquoi.** C'est écrit dans le
contexte terrain de `CLAUDE.md` depuis le premier jour ; cette nuit est celle où
ça devient une contrainte d'ingénierie.

Trois points.

**La fréquence est adaptative selon la vitesse.** Un chauffeur à l'arrêt n'a pas
besoin d'être suivi à la seconde ; un chauffeur qui roule, si. C'est le premier
levier sur la batterie, avant toute optimisation fine.

**Les positions s'agrègent avant d'être envoyées.** Un envoi par position, sur
un forfait de données compté, se voit sur la facture du chauffeur autant que sur
sa batterie.

**L'arrière-plan est le cas normal**, pas l'exception : un chauffeur regarde sa
carte de navigation, pas ton application. Une capture qui s'arrête quand l'app
passe en arrière-plan ne sert à rien.

Et pose les points de mesure dont L6-17 aura besoin — c'est elle qui dira si ce
lot est réussi, et elle ne pourra rien mesurer que tu n'aies instrumenté.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

**La vérification navigateur** des deux côtés, jusqu'à l'encaissement — et cette
fois avec une fin de course qui ne ment plus sur le trajet.

Lis les spécifications des tâches dépendantes : pour L3-10, lis L3-14 ; pour
L6-05, lis L6-17 et L6-16.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J24.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une course dont le trajet enregistré est celui qui a été parcouru — ou rien,
explicitement. Et une capture GPS dont tu peux me dire ce qu'elle coûte.
```

---

## Après cette nuit

Il restera onze nuits de périmètre pilote : l'inscription chauffeur (L6-15), le mode dégradé
(L6-16), les notifications push (L7-01, L7-04), les habilitations (L8-01, L8-02 — sous revue
humaine), les sauvegardes (L8-08), le back-office superviseur (L9-01 à L9-05), la file de rejeu
(L3-12), la facture (L4-06), l'écran de recette (L5-07), les scénarios de bout en bout (L10-01) et
le déploiement (L0-07).

Le détail, les dates et ce qui ferait glisser sont dans **`amoa/06-jalons-et-pilote.md`**.

Et les quatre démarches à lancer cette semaine, dont trois n'appartiennent qu'à vous — la
**passerelle SMS** en tête, parce que c'est elle qui fixera la date si elle ne part pas maintenant.
