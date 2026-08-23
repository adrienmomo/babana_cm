# Prompt de lancement — session de nuit J18

**Objectif** : fermer le parcours Client.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J17, endpoint fantôme retiré, L3-18 unification de l'état Redis"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-26.md`.

Commander une course fonctionne depuis cette nuit. Cette nuit-ci, on va jusqu'au
bout du parcours.

## Périmètre de cette session

**Corrections d'abord, elles sont courtes.**

1. **La recherche de lieu vers `mock-maps`** (D19) — même principe que
   `GOOGLE_ROUTING_URL` côté Odoo : une variable d'environnement, aucune branche
   conditionnelle dans le code. Prévois le petit adaptateur de forme que tu as
   identifié.
2. **`GET /drivers/nearby` retiré** du contrat et de `HTTP_ENDPOINTS`. Ta suite
   de conformité l'exerce aujourd'hui comme un 404 attendu — elle devra le
   perdre proprement, pas le garder en exception.

**Puis L6-09** — suivi de course en direct, puis résumé de fin.

## Sur la correction 1, et pourquoi elle passe en premier

Ton écart dit que sans elle, aucun point de départ ni d'arrivée ne peut être
désigné en mode simulé. C'est plus large qu'un défaut de câblage : **D19
promettait qu'un scénario complet soit parcourable sans aucun compte externe**,
et il ne l'est pas.

La règle que j'en tire, et qui est maintenant dans les prérequis : une
dépendance externe n'est simulée que si le parcours qui l'utilise fonctionne
sans compte. La présence du simulateur ne prouve rien ; seul l'usage le prouve.

Concrètement : sans cette correction, toute vérification navigateur future devra
répéter ton montage jetable. Une vérification qu'on redoute de refaire est une
vérification qu'on cesse de faire.

## L6-09 — quatre points

**Le suivi affiche, il ne dérive rien.** Position, ETA : tout vient de
`driver.position` (L3-09). Et l'ETA porte une vitesse moyenne plausible mais
jamais mesurée — pas de fausse précision à la minute.

**L'état de connexion est explicite, jamais implicite.** Un client qui perd le
réseau doit voir « position datée de N secondes », pas un marqueur figé qu'il
croira à jour. C'est la même exigence que pour la limitation de débit : un
silence est le pire des retours.

**Le partage de trajet et le bouton d'urgence sont ABSENTS, jamais inertes.**
L8-03 et L8-04 n'existent pas. Un bouton d'urgence qui ne fait rien est pire que
pas de bouton du tout — quelqu'un finira par compter dessus au mauvais moment.
C'est le seul écran où l'illusion coûte plus qu'une course.

**Décide explicitement quand l'immatriculation cesse d'être affichée.** Tu l'as
signalé toi-même : `ride.assigned` la porte, et rien ne l'efface après la fin de
course. Ce n'est pas grave, et c'est exactement le genre de donnée qu'on garde
par défaut faute d'avoir décidé. Décide.

Le résumé de fin est ce qu'un client relira en cas de litige : il doit être ce
que le serveur a écrit, pas ce que l'app a accumulé en route.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

**Et la vérification navigateur, sur le parcours entier** : commander, être
refusé, voir cinq autres chauffeurs, en choisir un, suivre son approche, lire le
résumé. C'est la troisième nuit de suite qu'elle trouve ce qu'aucune suite ne
voit — dis ce que tu as vu, pas seulement que tu as regardé.

Lis les spécifications des tâches dépendantes : pour L6-09, lis L6-10 et L4-09.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J18.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Un parcours complet dans un navigateur, de la carte au résumé de fin, sans un
seul contournement manuel.
```

---

## Après cette nuit

Le parcours Client sera complet, hors historique et factures (L6-10, qui dépend de L4-06).

Puis **L3-18** — l'unification de l'état Redis, avant que L3-10 et L3-11 n'ajoutent une quatrième
structure. Elle touche la réservation atomique : je la relirai moi-même, comme L3-06.

Ensuite le lot Chauffeur : moins d'écrans, plus exigeants, puisqu'on les regarde en conduisant.

Côté serveur : L3-12 (la file de rejeu), L4-06 (la facture), et **L8-03 / L8-04**, qui sont entrés
sur le chemin critique sans que mon découpage l'ait prévu.

Et toujours, à délai subi : **la validation du plan comptable** et **la vérification développeur
Android**.
