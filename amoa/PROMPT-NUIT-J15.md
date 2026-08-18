# Prompt de lancement — session de nuit J15

**Objectif** : refermer une faille de sécurité, puis mener le parcours Client jusqu'à
l'affectation.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J14, D37 le jeton rejouable est chiffré, doutes de L6-06 arbitrés"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-23.md`.

Son §1 est une correction de sécurité, et elle vient d'une décision que j'ai
écrite sans en voir la conséquence. Elle passe avant tout le reste.

## Périmètre de cette session

1. **D37** — le jeton rejouable est chiffré, et rien ne survit à la fenêtre
2. **Les trois doutes de L6-06** — géocodage, échec de localisation, abonnement
   refusé
3. **L6-07** — estimation, détail décomposé, choix du chauffeur parmi les cinq
4. **L6-08** — attente, refus, nouvelle sélection

**Si le lot ne passe pas en entier, arrête-toi après L6-07** et dis-le.

## D37 — ce que ton écart a trouvé, et ce qu'il sous-estimait

Ton analyse est juste : rejouer un jeton à l'identique suppose de l'avoir gardé
sous une forme récupérable, et un haché ne s'inverse pas. C'est ma rédaction de
D36 qui était contradictoire, pas ton implémentation.

**Mais le nettoyage n'est pas un détail à arbitrer.** `next_raw_token` n'est
effacé qu'à une représentation tardive de l'ancien jeton — un cas qui n'arrive
jamais quand tout se passe bien : le client reçoit son nouveau jeton et ne
repasse plus l'ancien. Donc chaque renouvellement laisse en base,
définitivement, le jeton de renouvellement **actuellement valide** de
l'utilisateur, en clair. Pas un vestige : le jeton vivant. Un vidage de base
donnerait la session de chaque utilisateur ayant renouvelé une fois.

**La sortie.** Le client qui a le droit de rejouer est exactement celui qui
possède l'ancien jeton. Chiffre le remplaçant avec une clé dérivée de cet ancien
jeton, dont la base ne garde que le haché : un vidage ne donne rien de
déchiffrable, et un client qui présente l'ancien jeton fournit du même geste la
clé de son remplaçant.

Et une tâche périodique efface à la fin de la fenêtre, sans attendre que
quelqu'un vienne redemander.

Deux critères ajoutés à L1-02, tous deux mécaniques : un test qui **lit la
table** et cherche la valeur en clair d'un jeton réellement émis, et un test du
cas normal — un client qui renouvelle et ne revient jamais ne laisse rien de
déchiffrable au-delà de la fenêtre. Écris-les avant le correctif, vois-les
rouges.

## Les trois doutes de L6-06

Tous les trois fondés. Les arbitrages sont dans le débrief §2 et dans les
spécifications (L6-06, L3-05).

Le troisième est celui qui m'inquiète le plus : **un silence est le pire retour
possible pour une limitation de débit**, parce qu'il pousse exactement au
comportement qui l'aggrave. C-02 gagne un accusé de réception pour
`nearby.subscribe` — accepté, ou refusé avec un délai avant nouvelle tentative.

## L6-07 et L6-08 — trois points

**Le détail décomposé est ce que le client vérifie de tête.** À Douala la
négociation à l'arrivée est la norme ; un tarif qu'on peut recalculer soi-même
est ce qui rend l'application crédible. Le montant et le détail dominent
l'écran (D20, exigence non esthétique), et les composantes affichées **somment
exactement** le total affiché — L2-04 a fait le travail côté serveur pour que
ce soit vrai, ne le défais pas en réarrondissant à l'affichage.

**L'ETA porte un facteur de correction, et il vaut 1.0 aujourd'hui** (É8, L10-03
non calibrée). N'affiche pas une précision que ce chiffre n'a pas.

**L6-08 est l'écran où D11 se voit** : un refus ramène à la sélection, sans
attribution automatique. C'est une décision de maîtrise d'ouvrage, et l'écran
doit rendre ce retour évident plutôt que subi — le risque connu est l'abandon du
client à ce moment précis. Il verra aussi les propositions expirer : un chauffeur
qui ne répond pas et un chauffeur qui refuse ne sont pas la même chose pour lui.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` est dû : D37 touche Odoo.

Lis les spécifications des tâches dépendantes : pour L6-07, lis L6-09 ; pour
L6-08, lis L3-07 et L3-08.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J15.md`, une entrée par tâche, commitée avec elle.

Et la même question qu'hier, dont la réponse a été la meilleure section du
rapport : **qu'est-ce qui, dans ces deux écrans, te laisse un doute pour un
client réel ?**

## Ce que j'attendrai demain matin

Un jeton dont aucune trace utilisable ne subsiste en base, prouvé par un test
qui lit la table. Et un parcours qui va de la carte au chauffeur affecté, dans
un navigateur.
```

---

## Après cette nuit

Il restera, côté Client : L6-09 (suivi de course et résumé) et L6-10 (historique et factures). Puis
les écrans Chauffeur — moins nombreux, mais plus exigeants : on les regarde en conduisant.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et les deux démarches à délai subi, toujours ouvertes : **la validation du plan comptable** et
**la vérification développeur Android**.
