# Prompt de lancement — session de nuit J25

**Objectif** : la capture GPS, et les réglages qui décideront si un chauffeur garde l'application.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J24, registre des décisions non portées, measured honnête, repli GPS"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-02.md`.

Son §1 est une faute de mon processus, pas de ton travail : une décision que
j'avais arbitrée le 27 août n'a jamais été portée par aucun prompt, et tu en as
signalé le symptôme deux fois sans qu'on fasse le lien. Elle est la première
tâche de cette nuit.

## Périmètre de cette session

1. **D42** — le numéro de téléphone révélé à l'affectation, effacé à la fin de
   course, des deux côtés
2. **`measured` honnête** — vrai si et seulement si au moins une position a été
   reçue
3. **L6-05** — capture GPS chauffeur

## D42 — ce qui manquait depuis quatre nuits

`ride.assigned` porte prénom, photo, gamme et immatriculation. Il doit porter le
**numéro de téléphone**, et symétriquement le chauffeur doit avoir celui du
client.

**L'effacement compte autant que la révélation** : à la fin de la course, des
deux côtés. Une donnée personnelle qu'on expose sans décider quand elle cesse de
l'être reste exposée par défaut — c'est ce que tu avais relevé toi-même pour
l'immatriculation.

Les deux écarts ouverts (`L6-09.md`, `L6-13.md`, le bouton d'appel) se referment
avec elle.

## `measured` honnête — ton doute, tranché

Ta formulation était meilleure que la mienne : *« ce n'est pas faux, mais c'est
le genre d'honnêteté littérale qui trompe. »*

Une accumulation qui n'a jamais reçu de position n'est pas une mesure de zéro,
c'est une absence de mesure. `measured` devient vrai si et seulement si au moins
une position est arrivée.

## L6-05 — et ce que cette nuit prépare vraiment

Tu as eu raison de ne pas la bâcler, et pour la bonne raison : **elle ne peut
être mesurée sur aucun banc d'ici.** Pas de build mobile, l'export web exclut
l'app Chauffeur.

La décision est prise : on l'écrit, et le coût réel sera relevé au pilote. Ce qui
veut dire que **cette nuit ne produit pas une capture optimisée — elle produit
une capture réglable et instrumentée.**

**Tout est paramétrable, sans exception** (invariant 5) : fréquences par état,
seuils de vitesse, taille des lots, périodicité d'envoi, précision demandée. Si
la batterie ne tient pas au pilote, la réponse doit être un changement de valeurs
le soir même. Une constante en dur ici, c'est une réécriture là-bas.

**Instrumente ce que L6-17 devra mesurer.** Elle ne mesurera rien que tu n'aies
posé : nombre de positions capturées, nombre envoyées, octets échangés, temps
passé avec le GPS actif. Ces compteurs valent plus que n'importe quelle
optimisation que tu ferais à l'aveugle ce soir.

**Écris le repli, ne le laisse pas à imaginer.** Le mode le plus économe — ne
capturer qu'en course, une position rare hors course — doit être atteignable par
configuration, pas par un développement. On perd la fraîcheur du géo-index, on
garde la flotte.

Et les trois exigences de la spécification : fréquence adaptative selon la
vitesse, agrégation avant envoi, **l'arrière-plan comme cas normal** — un
chauffeur regarde sa carte de navigation, pas ton application.

Un refus de permission ne bloque rien, et la capture s'arrête immédiatement au
passage hors ligne : un chauffeur qui a fini sa journée ne doit pas continuer à
émettre.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

Lis les spécifications des tâches dépendantes : pour L6-05, lis L6-17 (ce
qu'elle mesurera) et L6-16 (le mode dégradé).

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J25.md`, une entrée par tâche, commitée avec elle.

Et une question précise, en plus de la tienne : **quels réglages recommandes-tu
au premier jour du pilote, et lesquels sont les plus risqués ?** C'est ce que je
transmettrai à celui qui tiendra le téléphone.
```

---

## Après cette nuit

Il restera dix nuits de périmètre pilote : l'inscription chauffeur (L6-15), le mode dégradé
(L6-16), les notifications push (L7-01, L7-04), les habilitations (L8-01, L8-02 — sous revue
humaine), les sauvegardes (L8-08), le back-office superviseur (L9-01 à L9-05), la file de rejeu
(L3-12), la facture (L4-06), l'écran de recette (L5-07), les scénarios de bout en bout (L10-01) et
le déploiement (L0-07).

Le détail et les dates sont dans **`amoa/06-jalons-et-pilote.md`** — premières courses visées au
29 septembre, marge au 6 octobre.

Et les quatre démarches du §6, **dont la passerelle SMS**, qui fixera la date si elle ne part pas
cette semaine.
