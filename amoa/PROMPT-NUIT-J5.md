# Prompt de lancement — session de nuit J5

**Objectif** : rendre la boucle de course complète côté serveur — de l'estimation à l'encaissement.

**Lot volontairement court : cinq tâches.** Le dépôt est passé de 74 à 91 fichiers sources en une nuit, et chaque tâche coûte désormais plus de lecture que la précédente. Neuf tâches était le bon calibre sur un dépôt vide ; ça ne l'est plus. Mieux vaut cinq tâches finies et rapportées que huit tâches et aucun compte rendu.

---

## À faire avant de lancer

```bash
git add -A
git commit -m "amoa: débrief J4, rapport par tâche, dépendance L4-11 corrigée"
```

Un `.pyc` orphelin traîne de l'ancien test de concurrence supprimé — sans conséquence, mais autant nettoyer :

```bash
find code -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier — deux règles nouvelles y figurent depuis ce matin :
le rapport s'écrit tâche par tâche, et le lot rétrécit à mesure que le code
grandit.

Puis `amoa/questions/L4-03.md` et `amoa/questions/L4-11.md`, écrits la nuit
dernière : ils décrivent précisément ce qui manque au cycle de vie et pourquoi.

## Ce qui a changé dans le protocole

**L'entrée de rapport fait partie de la définition de fini.** Point 8. Elle
s'écrit et se commite **avec la tâche**, pas à la fin de la session.

La nuit dernière a été interrompue en cours de route — limite atteinte, plantage,
reprise dans une autre session. Le lot a été mené à bien, mais le compte rendu,
rédigé en un seul geste final, n'a jamais existé. La session suivante a dû
reconstituer l'état depuis les messages de commit.

**Le rapport n'est pas une documentation, c'est l'état de la session.** Écris-le
comme un document de passation : si tu t'arrêtes brutalement après la tâche 3,
celui qui reprend doit savoir où tu en étais, ce que tu as supposé, ce que tu as
laissé rouge.

**Commite chaque tâche finie plutôt que d'accumuler.** Ne laisse jamais l'arbre
de travail dans un état intermédiaire entre deux tâches.

## Périmètre de cette session

Cinq tâches, dans cet ordre. Chacune débloque la suivante.

1. **L2-04** — endpoint de cotation `POST /quote`, modèle `babana.quote`,
   et **ajout de `pickup_zone_id` / `dropoff_zone_id` sur `babana.ride`**
   (affectation du 13 août : L9-07 doit produire les zones les plus actives,
   impossible si la course ne les porte pas)
2. **L2-05** — distance de référence auprès de l'API de routage simulée, avec
   cache par paire de zones
3. **L4-04** — consolidation de fin de course : distance, durée, tracé archivé
   en une écriture, montant final, écart signalé
4. **L4-03R** — compléter les endpoints manquants que L2-04 et L4-04 débloquent :
   `POST /rides` (création depuis une estimation) et `POST /rides/{id}/complete`
5. **L3-01** — authentification des connexions WebSocket, première tâche du
   service temps réel

N'entreprends aucune tâche hors de cette liste. En particulier **pas L4-05 ni
L5-01** : l'encaissement touche au compte courant chauffeur, donc à la logique
financière, qui demande une revue humaine avant d'exister.

À l'issue de ce lot, une course sera menable de `requested` à `completed` par
l'API mobile. Il restera l'encaissement et le suivi temps réel pour J3.

## Points d'attention

**L2-04, l'estimation est persistée et opposable.** La course référence
l'estimation plutôt que de recalculer — c'est ce qui garantit que le client paie
ce qu'on lui a montré. L'estimation gèle la règle tarifaire appliquée, pas
seulement son identifiant : si la grille change entre l'estimation et la course,
le tarif montré reste opposable. Elle expire, sinon un client estime aux heures
creuses et commande aux heures de pointe.

**L2-05, la distance vient d'un modèle voiture.** É8, assumé. Un commentaire
explicite au point de calcul, sinon quelqu'un « corrigera » plus tard en sommant
les points GPS et cassera la reproductibilité des factures. L'indisponibilité de
l'API produit une erreur explicite, jamais une estimation dégradée silencieuse —
une estimation fausse est pire qu'une absence d'estimation.

**L4-04, le montant final se calcule sur la distance de référence**, pas sur la
distance parcourue. Décision par défaut, à confirmer par L10-05 sur données de
pilote. L'écart au-delà du seuil est **signalé, jamais corrigé automatiquement** :
il peut révéler un détour, un problème GPS ou une adresse mal saisie, et c'est au
back-office de trancher.

**L4-03R doit traduire la violation d'index unique en `DRIVER_ALREADY_TAKEN`.**
Aujourd'hui elle remonte en erreur technique brute — relevé dans
`amoa/questions/L4-03.md` et laissé tel quel faute de la réservation atomique en
amont. La réservation reste à L3-06, mais la traduction de l'erreur, elle, se
fait ici.

**L3-01 ouvre le lot le plus délicat du projet.** La connexion porte un contexte
immuable — identité, rôle — et **aucun message entrant ne peut redéfinir
l'identité de son émetteur**. Un message qui porte un identifiant de chauffeur
différent de celui de la connexion est rejeté, jamais honoré. Validation locale
du jeton, sans appel à Odoo : un appel sortant par connexion ne passerait pas à
l'échelle.

## Protocole — inchangé

Lis les spécifications des tâches dépendantes : pour L2-04, lis L2-06 et L2-07 ;
pour L3-01, lis L3-02 et L3-04.

Les fichiers d'écart vont sur `master`, toujours.

Les champs-pont sont tracés, et la tâche cible commence par supprimer ceux qui la
nomment : **L2-04 doit faire disparaître `quote_reference`** de `babana.ride`, et
le remplacer par une vraie relation vers `babana.quote`.

Exécute la suite au moins une fois sur une base fraîche avant de déclarer une
tâche finie. C'est ce qui a révélé le défaut de fuseau horaire la nuit dernière.

## Rapport

`amoa/rapport-nuit-J5.md`, **une entrée écrite et commitée avec chaque tâche**.
Même structure que les nuits précédentes.

Si tu sens que le lot ne passera pas en entier, dis-le dans le rapport plutôt que
d'accélérer — cinq tâches finies et documentées valent mieux que cinq bâclées.

## Ce que j'attendrai demain matin

Une course menable de bout en bout jusqu'à `completed` par l'API, et le service
temps réel amorcé. Et un rapport, cette fois — même partiel.
```

---

## Après cette nuit

Il restera, pour J3 : l'encaissement (L4-05, L5-01, à faire sous revue humaine puisque c'est de la logique financière) et l'essentiel du lot L3 — géo-index, réservation atomique, suivi. Puis les écrans.

Et toujours, inchangé depuis quatre jours : le compte Google Play.
