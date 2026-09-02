# Prompt de lancement — session de nuit J35

**Objectif** : regarder enfin les écrans, puis rendre le produit utilisable sur un réseau qui
coupe.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J34, identifiants back-office à réparer, revue visuelle due"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-11.md`.

Ton doute principal était le bon, et j'ai trouvé sa cause : le mot de passe
administrateur que `05-prerequis-et-simulation.md` décrit depuis le premier jour
n'a jamais été construit. Tu ne pouvais pas deviner ce qui n'existe pas.

## Périmètre de cette session

1. **Les identifiants du back-office**, et la revue visuelle qui en dépend
2. **Le client JSON-RPC retiré**
3. **L6-16** — mode dégradé réseau

## 1. Les identifiants, puis regarder

Le jeu de données pose un mot de passe administrateur depuis une variable
explicite. **Pas de valeur par défaut en production** (D43) : vide dans le
fichier d'exemple, renseignée par la configuration de développement.

Puis **ouvre chaque écran du back-office** — chauffeurs, flotte, courses, zones
et grilles, remises et écarts — et dis ce que tu vois. Pas « la page se charge » :
est-ce que le bandeau de recouvrement de zones se lit, est-ce que le tableau de
bord en trois blocs tient sur un écran, est-ce qu'un superviseur comprend en le
regardant ce qu'il doit faire.

C'est D38 appliqué aux vues Odoo : trois nuits d'écrans prouvés corrects et
jamais vus. Et l'étape 8 de la démonstration passe par là.

**Si un écran se lit mal, corrige-le** — c'est le moment, et une mise en page ne
se juge pas sur une capture qu'on ne prend pas.

## 2. Le client JSON-RPC

Son commentaire promet un pont que D35 a aboli le 22 août, et tu viens de
construire les lectures correspondantes en REST. J'avais écrit qu'il pouvait
rester « s'il ne coûte rien » : il coûte quelque chose, il décrit une intention
qui n'existe plus. Même geste que l'endpoint fantôme.

## 3. L6-16 — le mode dégradé, et ce qu'il décide

C'est la tâche la plus lourde de ce qui reste, et celle qui décide si le produit
tient à Douala. **Le réseau qui coupe est le cas courant, pas l'exception** —
c'est écrit dans le contexte terrain depuis le premier jour, et cette tâche est
celle où ça devient du code.

Quatre points.

**L'état affiché n'est jamais ambigu.** Un chauffeur qui a accepté une course
doit savoir si le serveur l'a su. « Envoi en cours » et « accepté » ne sont pas
la même chose, et la différence décide s'il démarre son moteur.

**La file rejoue des actions, jamais des déclarations d'intérêt.** Tu as posé
cette distinction toi-même en J22, et elle est écrite : une action se rejoue,
« ce que je veux maintenant » se réémet. Ne la perds pas en généralisant la file.

**Le rejeu est idempotent de bout en bout.** Le mécanisme existe côté serveur
depuis L4-03 et il a été éprouvé par le rejeu de requête d'Odoo en J17 —
appuie-toi dessus plutôt que d'inventer une déduplication côté client.

**Et une action qui échoue définitivement se dit.** Une file qui avale
silencieusement est pire qu'une erreur immédiate : le chauffeur croit avoir
accepté, et personne ne vient.

Lis L3-11 (la resynchronisation) et L6-04 (le client temps réel) : la moitié du
travail y est déjà, et cette tâche l'assemble plutôt qu'elle ne la refait.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J35.md`, une entrée par tâche, commitée avec elle.

Et pour la revue visuelle, une question précise : **quel écran du back-office
demanderait le plus d'explication à un superviseur qui le découvre ?** C'est
celui-là qu'on retravaillera.

## Ce que j'attendrai demain matin

Ce que tu as vu dans le back-office, écran par écran. Et un chauffeur qui
accepte une course dans un tunnel et sait, en sortant, si elle est à lui.
```

---

## Après cette nuit

Restera, en périmètre pilote : la file de rejeu (L3-12), la facture (L4-06), les sauvegardes
(L8-08), les scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone — à laquelle s'ajoute désormais la revue visuelle des
écrans Chauffeur, que l'export web ne permet pas (D22).

**Cinq tâches, dont une seule dépend de vous.** Premières courses visées au 13 octobre —
`amoa/06-jalons-et-pilote.md`.
