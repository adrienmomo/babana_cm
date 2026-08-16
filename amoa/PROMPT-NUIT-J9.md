# Prompt de lancement — session de nuit J9

**Objectif** : que tout ce qui a été construit depuis trois nuits soit enfin atteignable.

**Une seule tâche, de taille L.** C'est délibéré : le câblage est le chemin critique, et il porte
un piège qui mérite d'être traité sans rien d'autre à côté.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J8, L3-17 câblage et réconciliation, critère 6 bis sur le pool"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-17.md`.

Son point 4 dit l'essentiel : `reserveDriver`, `ProposalLifecycle` et
`clearEngaged` n'ont aucun appelant en production. Trois nuits de code correct,
testé, prouvé — et rien de tout cela n'est atteignable depuis l'application
mobile. Cette nuit répare ça.

## Périmètre de cette session

Une tâche, **L3-17**, spécifiée dans `amoa/specs/L3-temps-reel.md`.
Plus une correction courte au démarrage.

**Correction d'abord (courte).** `addToPool` — le `GEOADD` inconditionnel —
sort de `src/redis/geo-index.ts` et devient une aide de test. Les trois fichiers
qui l'utilisent comme fixture (`nearby.test.ts`, `geo-index.test.ts`,
`availability.test.ts`) composent leurs fixtures par le vrai chemin : marquer en
ligne, puis appeler le script d'éligibilité. Tu avais toi-même décrit ce trou
dans `amoa/questions/L3-06R.md` — ton analyse était juste, mon arbitrage diffère
sur la valeur, pas sur les faits : une règle de lint avec un trou documenté
donne une confiance qu'elle ne mérite pas.

Puis L3-17 en entier. N'entreprends rien d'autre — ni L3-08, ni L3-09, ni
l'encaissement.

## Le piège central, à traiter en premier

**Odoo rejoue la requête HTTP entière** sur conflit de concurrence — tu l'as
découvert toi-même en J7. Un appel sortant vers le service temps réel placé dans
un contrôleur rejouable **s'exécute donc deux fois**. Une réservation exécutée
deux fois, c'est un chauffeur réservé puis re-réservé, ou pire, une seconde
réservation qui échoue et fait échouer une requête qui avait réussi.

Deux réponses possibles, à choisir explicitement et à documenter dans le
rapport :

- rendre l'appel idempotent de bout en bout, par une clé de requête que le
  service temps réel reconnaît et dont il rejoue la réponse ;
- ou sortir l'appel de la transaction rejouable.

Ce qui n'est pas acceptable, c'est de ne pas trancher. Choisis, dis pourquoi,
et **écris le test qui provoque un vrai rejeu** — pas un double appel simulé par
le test, un rejeu réellement déclenché par un conflit de concurrence. C'est le
critère 3 de la tâche, et c'est celui qui compte.

Bonne nouvelle que tu as relevée toi-même : `accept`/`reject`/`expire` sont déjà
idempotents par construction. La réservation, elle, ne l'est pas encore.

## La réconciliation fait partie de la tâche

Le marqueur d'engagement n'expire jamais — c'est voulu. Mais un marqueur qui
n'expire jamais et qu'un seul échec laisse en place rend le chauffeur invisible
**pour toujours** : il émettra ses positions, son app lui dira qu'il est en
ligne, et il ne recevra plus jamais une course. C'est le scénario du contexte
terrain de `CLAUDE.md`, avec une clé Redis pour cause.

Le service temps réel demande donc périodiquement à Odoo la liste des chauffeurs
réellement en course et aligne ses marqueurs dessus. Odoo décide, le temps réel
reflète.

**Et l'écart se compte et se journalise.** Un écart durablement non nul n'est
pas un incident de réconciliation, c'est un défaut du chemin nominal. La
réconciliation le répare *et* le dénonce. Une réconciliation silencieuse est la
façon la plus efficace de ne jamais corriger la vraie cause.

## Deux points en attente depuis longtemps, qui se traitent ici

**La précondition C-03 « chauffeur présent dans la dernière liste des 5 »**, que
tu signales depuis L3-06. C'est la première nuit où les deux côtés se parlent,
donc la première où la vérifier a un effet.

**L'effacement de l'engagement en fin de course.** Sans lui, le chauffeur ne
revient jamais dans le pool.

## Protocole — inchangé

Un commit par étape logique, avec son entrée de rapport. La tâche est grande :
ne la commite pas en un seul geste à 4 h du matin.

Cette tâche touche Odoo. **`make reset` complet est dû** avant de la déclarer
finie — les deux nuits précédentes ne touchaient que le service temps réel et
s'en sont dispensées à juste titre, ce n'est plus le cas.

Lis les spécifications des tâches dépendantes : L3-12 (appels sortants, que tu
ne dois pas réimplémenter) et L4-03.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

**Si le lot ne passe pas en entier, dis-le et arrête-toi proprement.** Une
réservation câblée et prouvée vaut mieux qu'un câblage complet à moitié testé —
c'est la tâche où un défaut se paiera le plus cher.

## Rapport

`amoa/rapport-nuit-J9.md`, une entrée par étape, commitée avec elle.

## Ce que j'attendrai demain matin

Une course qui va de `requested` à `assigned` par l'API mobile, réservation
atomique comprise, contre la pile réelle. Et deux clients qui sélectionnent le
même chauffeur : un seul gagne, sans course fantôme.
```

---

## Après cette nuit

Le lot L3 aura son ossature complète et intégrée. Resteront l'élargissement du rayon (L3-08), le
suivi diffusé (L3-09), l'accumulation (L3-10), la reconnexion (L3-11), le test de résilience
(L3-14), et les deux canaux de lecture (L3-15, L3-16).

**Puis l'encaissement — L4-05 et L5-01, sous revue humaine.** Huit nuits d'attente, et c'est ce qui
manque pour qu'une course soit démontrable de bout en bout, encaissement compris. Ce sera la
priorité de J10 si le câblage passe.

Et toujours : **le compte Google Play.** Sept jours.
