# Prompt de lancement — session de nuit J39

**Objectif** : fermer les trois écarts entre « le mécanisme marche » et « la machine marche ».

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J38, D62/D63, critères 6 et 7 de L8-08, corollaire du point 9 précisé"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier — **le corollaire du point 9 a été précisé, et une
règle sur les scripts d'exploitation ajoutée à côté**. Puis
`amoa/questions/REPONSES-2026-09-15.md`.

Hier soir, exécuter `backup.sh` pour de vrai a trouvé trois défauts en une
soirée, dont un grave : le dump et les pièces d'identité des chauffeurs
partaient en clair. Aucune relecture ne les aurait produits. C'est le motif de
tout ce projet depuis deux semaines, et tu l'as appliqué de toi-même.

## Périmètre de cette session

1. **Les images du jeu de démonstration** (D63)
2. **`restore.sh` exécuté comme script** (D62, critère 6 de L8-08)
3. **`bootstrap.sh` installe `age` et `rclone`** (critère 7 de L8-08)

## 1. D63 — un enregistrement qui pointe vers rien remplit une ligne, pas un écran

Tu as trouvé hier un document de chauffeur dont la clé de stockage pointe vers
un objet inexistant, et tu as écrit n'avoir pas balayé le reste. J'ai balayé
depuis l'autre bout : `services/odoo/scripts/seed.py` **ne téléverse aucune
image, nulle part**. Ce n'est pas un enregistrement défectueux, c'est tout le
jeu de données.

Conséquence : l'écran où un superviseur regarde un permis pour approuver un
chauffeur n'a jamais été vu avec une image. C'est le geste central de L6-15, et
c'est une étape de la démonstration au client.

**Ce qu'on met derrière** : une image générée au moment du semis, portant en
clair « DOCUMENT DE DÉMONSTRATION », le nom du chauffeur et le type de pièce.
Générée, pas commitée — aucun binaire n'entre dans le dépôt. Visiblement
factice : une pièce d'identité crédible mais fausse est un objet dont on ne veut
pas, et qui finirait par circuler.

Le semis reste idempotent, et il téléverse par le même chemin que
l'application — `services/storage.py`, jamais un appel direct au client S3 qui
contournerait la couche que le reste utilise.

**Puis ouvre l'écran** : la fiche d'un chauffeur en attente, le permis affiché,
le geste d'approbation et celui de rejet. Dis ce que tu vois. Si l'image ne
s'affiche pas — URL signée expirée, en-tête manquant, aperçu absent — c'est
précisément le défaut que cette tâche existe pour révéler, et il vaut la nuit.

## 2. D62 — un script se vérifie en le lançant

Ta preuve d'hier a rejoué les **commandes** de `restore.sh`, pas le script. Tu
l'as écrit clairement, et c'est pour ça que je peux le reprendre ici.

Un script porte un ordre, des gardes, des valeurs par défaut, des codes de
retour et un comportement en cas d'échec partiel. Rien de tout ça n'est exercé
quand on en extrait les lignes utiles. Exemple immédiat, à vérifier : l'en-tête
de `restore.sh` annonce `infra/env/.env` comme prérequis, alors que le script le
déchiffre lui-même quelques lignes plus bas. Une exécution tranche ça en dix
secondes.

**Lance-le, en entier, avec `RESTORE_COMPOSE_PROJECT`** vers des conteneurs
neufs — le mécanisme d'isolation que tu as ajouté hier existe exactement pour
ça. Les mêmes quatre éléments à retrouver qu'hier soir, et la commande exacte
que tu as lancée consignée dans le journal de `docs/operations/production.md`.

Les contournements `age`/`rclone` par images Docker restent légitimes et hors
du dépôt : ce qui compte est que `restore.sh` s'exécute tel quel.

Et c'est un script qu'on lance à trois heures du matin, quand la base a disparu.
Ce n'est pas le moment de découvrir qu'une garde ne passe pas.

## 3. Critère 7 — l'hôte porte ce que les scripts exigent

`backup.sh` refuse de démarrer sans `age` ni `rclone`, et rien ne les installe.
Un VPS provisionné en suivant la procédure ne sauvegarderait pas, et le
découvrirait le premier soir.

`bootstrap.sh` les installe. Il porte déjà le durcissement SSH et le pare-feu :
c'est le bon endroit, c'est le seul script qui touche l'hôte lui-même.

**Et corrige au passage l'apostrophe de `${VAR:?...}`** que tu as signalée dans
`bootstrap.sh` — même défaut que celui que tu as corrigé dans `backup.sh`, tu
l'avais laissé hors périmètre à juste titre, il y rentre ce soir.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

**Et le point 9**, qui est le cœur de la première tâche : l'écran de validation
d'un document, avec une image dedans, vu de tes yeux.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J39.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un permis affiché à l'écran, et `restore.sh` lancé d'un bout à l'autre avec sa
ligne dans le journal.
```

---

## Après cette nuit

Périmètre pilote restant : **L3-14** (résilience), **L10-01** (scénarios de bout en bout),
**L1-09** (OTP, suspendu à la passerelle SMS) et **L6-19** (la demi-journée avec un téléphone).

**Et la démonstration n'attend que le VPS.** En simulé, fermée par `WEB_ALLOWED_IPS`, sans compte
externe — déroulé dans `amoa/07-demonstration.md`. Après cette nuit, l'étape de validation d'un
chauffeur y sera montrable.

**Un geste reste le vôtre, et lui seul** : restaurer une sauvegarde sur un hôte vierge, chez un
autre hébergeur. Le journal de `docs/operations/production.md` §7 l'attend, encore vide. Tant
qu'il l'est, L8-08 n'est pas finie — c'est sa propre définition.
