# Prompt de lancement — session de nuit J8

**Objectif** : refermer la faille du pool, puis le cycle de proposition.

**Deux entrées.** La première est une correction que j'ai trouvée en relisant ton code — le script
Lua était juste, l'invariant ne l'était pas.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J7, D26 pool à écrivain unique, D27 sens de dépendance, L3-16"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-16-J7.md`.

Ce fichier contient ma relecture de L3-06, que je m'étais engagé à faire. Ton
script Lua est correct et ton test de concurrence est sérieux. L'invariant est
cassé quand même, par un autre chemin. Lis le point 2 avant d'écrire quoi que
ce soit.

## Périmètre de cette session

Deux entrées, dans cet ordre.

1. **L3-06R** — le pool n'a qu'un écrivain (D26), et l'engagement est un état
   distinct de la réservation
2. **L3-07** — cycle de proposition : notification, délai, acceptation, refus,
   expiration

N'entreprends rien d'autre. En particulier **pas le câblage Odoo ↔ temps réel** :
il demande un endpoint entrant et un secret partagé qui n'existent nulle part,
et il porte un piège que je veux traiter à part (voir plus bas).

## L3-06R — ce qu'il faut réparer

**Le défaut.** `ingestPosition` (L3-02) appelle `addToPool` à chaque position
acceptée d'un chauffeur en ligne, sans rien savoir de la réservation. Un
chauffeur réservé revient dans le pool à sa position suivante — quelques
secondes — et un second client peut le gagner. Ton test de concurrence ne le
voit pas parce qu'il n'émet aucune position pendant la réservation.

**La correction.** Toute écriture sur le pool passe par un **seul script
atomique**, qui porte l'unique définition de l'éligibilité : en ligne, non
réservé, non engagé. Aucun `GEOADD` direct ne subsiste ailleurs — ni dans
l'ingestion, ni dans la bascule en ligne, ni dans `releaseDriver`. C'est
maintenant une frontière de lint.

**Et le second défaut, du même sang.** Rien ne supprime la réservation quand le
chauffeur accepte. Elle expire donc en pleine course, ton veilleur déclenche
`releaseDriver`, qui trouve le chauffeur en ligne avec une position fraîche —
les deux sont vrais pendant une course — et le remet dans le pool avec un
passager derrière. Réservation et engagement se séparent par leur durée : la
réservation expire vite, l'engagement n'expire jamais tout seul.

**Les tests d'abord, cette fois.** Écris les deux tests qui échouent avant de
corriger : un chauffeur réservé qui émet des positions pendant sa réservation,
et un chauffeur engagé dont la réservation expire. Vois-les rouges. C'est la
politique de non-régression de `CLAUDE.md`, et c'est aussi la seule preuve que
la correction porte sur le bon défaut.

## L3-07 — le cycle de proposition

C'est cette tâche qui **pose le marqueur d'engagement** à l'acceptation, en
remplacement de la réservation. Le lien entre les deux tâches de la nuit est là.

Relis le point d'idempotence de la spécification : une acceptation qui arrive
après l'expiration doit échouer proprement, jamais créer une course fantôme.
C'est le cas de course le plus probable du projet — le chauffeur appuie à
temps, le message arrive en retard, parce que le réseau de Douala est lent.
Ce n'est pas un cas limite à traiter si le temps le permet.

Le compte à rebours affiché côté chauffeur est indicatif ; le serveur est seul
juge de l'expiration. Un client qui décide de l'expiration produit deux vérités.

## Ce qu'il ne faut pas faire cette nuit, et pourquoi

`select-driver` n'appelle toujours pas la réservation. Tu l'as signalé, tu as eu
raison de ne pas le brancher au passage. Ce sera une tâche dédiée, et elle porte
un piège que je préfère te dire maintenant pour que tu ne le poses pas par
avance : **Odoo rejoue la requête HTTP entière** sur conflit de concurrence
(c'est ce que tu as découvert hier). Un appel sortant vers le service temps réel
placé dans un contrôleur rejouable s'exécutera donc deux fois. La réservation
devra être idempotente, ou l'appel devra sortir de la transaction rejouable.

Même remarque pour la précondition C-03 « chauffeur présent dans la dernière
liste des 5 » que tu as relevée : elle se traitera avec le câblage, pas avant.
La vérifier côté temps réel sans que le câblage existe n'aurait aucun effet.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

Lis les spécifications des tâches dépendantes : pour L3-07, lis L3-08
(élargissement du rayon) et L3-09 (suivi), et C-03.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

Base fraîche avant de déclarer une tâche finie.

## Rapport

`amoa/rapport-nuit-J8.md`, une entrée par tâche, commitée avec elle.

## Ce que j'attendrai demain matin

Un chauffeur réservé qui émet des positions pendant toute sa réservation et qui
ne revient jamais dans le pool. Et une proposition qui expire proprement, même
quand l'acceptation arrive une seconde trop tard.
```

---

## Après cette nuit

Le lot L3 sera aux trois quarts : resteront l'élargissement du rayon (L3-08), le suivi diffusé
(L3-09), l'accumulation dans Redis (L3-10), la reconnexion (L3-11), les appels sortants vers Odoo
(L3-12) et le test de résilience (L3-14) — plus L3-15 et L3-16, les deux canaux de lecture.

**Puis le câblage Odoo ↔ temps réel**, qui mérite sa propre nuit : c'est là que se rencontrent le
rejeu de requête d'Odoo, l'idempotence de la réservation et la précondition des cinq chauffeurs.

Et L4-05 / L5-01, l'encaissement, en attente depuis sept nuits. Après quoi une course sera
démontrable de bout en bout, encaissement compris.

Et toujours : **le compte Google Play.**
