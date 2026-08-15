# Prompt de lancement — session de nuit J7

**Objectif** : la réservation atomique, précédée de ce qui doit être sain avant elle.

**Trois tâches, dont la plus risquée du projet.** L3-06 ne se fusionne pas sans ma relecture.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J6, D25 rejeu de transaction, L3-15 canal de configuration"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-16.md`.

Ce fichier corrige un diagnostic que tu as posé la nuit dernière, et il te
donne raison sur le constat. Lis-le avant d'ouvrir `babana_ride_state.py` :
tu y as vu un défaut de verrouillage, il n'y en a pas ; le défaut est ailleurs,
et il est dans ma spécification.

## Périmètre de cette session

Trois tâches, dans cet ordre.

1. **L4-02R** — rejeu de transaction sur échec de sérialisation (D25), et
   correction du scénario 2 de L4-11
2. **L3-05** — endpoint « 5 chauffeurs les plus proches »
3. **L3-06** — réservation atomique du chauffeur, **et L3-13, son test de
   concurrence, dans la même tâche**

N'entreprends rien d'autre. Pas L3-07, pas L4-05, pas L5-01.

## L4-02R — le rejeu (D25)

`_lock_for_update()` traduit aujourd'hui un `SerializationFailure` en
`RIDE_INVALID_TRANSITION`. C'est moi qui l'ai arbitré le 14 août, et c'était
faux : PostgreSQL ne dit pas « ta demande est invalide », il dit « ton
instantané est périmé, rejoue-moi ».

Le rejeu **reprend au début de la transition**, pas seulement du
`SELECT ... FOR UPDATE` — relire l'état sans réévaluer la précondition serait
pire que ne rien faire. Il est **borné** : trois échecs consécutifs ne sont plus
un aléa d'ordonnancement mais une contention réelle, qui doit se voir dans les
journaux plutôt que se faire absorber.

Puis le scénario 2 de `test/concurrency/ride-transitions.test.ts`. Sa nouvelle
rédaction est dans `amoa/specs/L4-course.md`, L4-11. Retiens le point de
raisonnement : `accept` puis `cancel` n'est pas une paire qui s'exclut, c'est
une séquence légitime — `assigned` est annulable. Ce que le scénario prouve
désormais, c'est que l'issue ne dépend pas de l'ordonnanceur, pas qu'une seule
transition gagne.

**Ce n'est pas « adapter le test au code ».** Je change un critère qui
contredisait C-03. Si tu te trouves un jour à faire ce geste sans qu'une
spécification l'ait explicitement autorisé, arrête-toi et signale.

Vérifie à blanc, comme pour C2 la nuit dernière : sans le rejeu, le scénario 2
doit échouer.

## L3-05 — les 5 plus proches

Lis les garde-fous du tableau de la spécification : ils sont tous obligatoires,
et le critère 4 vérifie l'**absence** des champs interdits, pas la présence des
champs attendus.

Un point ajouté ce matin : ton nettoyage paresseux de L3-03 sur-échantillonne
d'un facteur fixe pour absorber les positions expirées. Après une coupure réseau
généralisée — le cas courant à Douala, pas un cas limite — ce facteur ne suffira
pas et la liste rendra deux chauffeurs au lieu de cinq. Un client qui voit deux
chauffeurs croit que la ville est vide. Complète jusqu'à cinq.

## L3-06 — la réservation atomique

**La tâche la plus risquée du projet, et celle où une solution qui « marche »
peut être fausse.**

Un seul script Lua exécuté par Redis. Aucune logique conditionnelle en
TypeScript entre la lecture et l'écriture. Si tu écris
`if (await isAvailable(id)) { await reserve(id) }`, la tâche est ratée, même si
tous les tests passent — c'est ce que dit sa spécification, et c'est à prendre
au pied de la lettre.

**L3-13 fait partie de cette tâche, pas d'une autre nuit.** N réservations
simultanées du même chauffeur, contre un vrai Redis, répétées un grand nombre de
fois. Et son point 5, qui est le seul qui compte vraiment : remplace un instant
la réservation atomique par une implémentation naïve en deux temps, et vérifie
que le test **échoue**. Un test de concurrence qui passerait aussi sans
l'atomicité ne prouve rien. Tu l'as fait de toi-même pour C2 la nuit dernière et
ça a révélé un défaut dans le test — même geste ici, obligatoire.

Le géo-index que tu as écrit hier ne connaît aucune règle métier, et c'est ce qui
te permet de l'utiliser ici sans le réécrire. Garde cette frontière.

**Si quelque chose te paraît impossible à rendre atomique**, arrête-toi et
écris-le dans `amoa/questions/L3-06.md`. Une fenêtre de course contournée en
silence produit deux clients sur le même chauffeur, en production, sous charge,
et personne ne saura pourquoi.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport. C'était bien fait la nuit
dernière ; c'est le rythme à garder.

Lis les spécifications des tâches dépendantes : pour L3-06, lis L3-07 (le cycle
de proposition) et C-03.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

Base fraîche avant de déclarer une tâche finie. Trois nuits de suite, `make
reset` a révélé quelque chose qu'aucune suite verte ne montrait.

## Rapport

`amoa/rapport-nuit-J7.md`, une entrée par tâche, commitée avec elle.

## Ce que j'attendrai demain matin

Une annulation après acceptation qui aboutit à tous les coups, et un chauffeur
que deux clients ne peuvent pas gagner en même temps — prouvé par un test qui
échoue si on retire l'atomicité.
```

---

## Après cette nuit

Il restera, pour le lot L3 : le cycle de proposition (L3-07), l'élargissement du rayon (L3-08), le
suivi diffusé au client (L3-09), l'accumulation dans Redis (L3-10), la reconnexion (L3-11), les
appels sortants vers Odoo (L3-12) et le test de résilience (L3-14). Plus **L3-15**, le canal de
configuration créé ce matin, qui fera disparaître les variables d'environnement de J6.

**L3-12 mérite une nuit à elle seule.** C'est là que la règle de partition se matérialise ou se
perd : toute tentation d'écrire dans Odoo à un cinquième moment doit être refusée et remontée.

Et L4-05 / L5-01, l'encaissement, en attente depuis six nuits. Après L3-06, ce sera la priorité.

Et toujours : **le compte Google Play.**
