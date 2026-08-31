# Prompt de lancement — session de nuit J28

**Objectif** : qu'un chauffeur dont l'application était fermée voie une proposition encore valable,
avec le temps qu'il lui reste vraiment.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J27, resynchronisation explicite, mesure jusqu'à l'affichage, date révisée au 13 octobre"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-05.md`.

Ton écart m'a corrigé : j'avais écrit dans le prompt de J27 que `ProposalScreen`
revalidait déjà auprès du serveur. C'était faux, tu l'as vérifié dans le dépôt
avant d'écrire du code, et tu as eu raison de t'arrêter là-dessus.

## Périmètre de cette session

**L7-04, en tâche pleine** — contrat, service temps réel, application. Pas un
reliquat de lot.

## La revalidation — et la réserve qui change la forme

Ton option A est retenue : réutiliser le chemin existant plutôt qu'ajouter une
paire de messages.

**Mais la réponse doit être explicite.** Si l'application attend de voir si une
proposition arrive pour conclure qu'il n'y en a pas, on réintroduit l'inférence
par le silence que D49 a supprimée — et le délai à inventer serait faux, comme
tous les délais inventés sur ce réseau.

La réponse de resynchronisation dit donc s'il y a une proposition active, et si
oui ses détails et sa **véritable échéance**. Pas de proposition dans la
réponse, pas de proposition. Rien à deviner.

**Aligne les deux durées que tu as repérées.** Le délai stocké côté Redis est
celui de la réservation, pas celui de l'acceptation. Deux valeurs voisines
qu'on prend l'une pour l'autre — et le compte à rebours « honnête » serait
honnêtement faux.

C'est le cœur de la tâche : un chauffeur qui ouvre sa notification vingt-cinq
secondes après l'émission doit voir cinq secondes. Une proposition qu'on croit
avoir le temps d'accepter et qui expire pendant qu'on la lit est pire qu'une
proposition manquée.

## La mesure — jusqu'à l'affichage, pas jusqu'à Firebase

Le serveur ne peut observer seul que l'acceptation de son envoi. Tout le délai
qui compte vit après : veille du système, réseau, réveil de l'appareil.

L'application signale donc quand la proposition s'est **réellement affichée**.
C'est le seul chiffre qui répond à la question posée — un chauffeur a-t-il vu la
course à temps — et sans lui on ne saura pas distinguer un chauffeur qui refuse
d'un chauffeur prévenu trop tard. Ces deux-là appellent des réponses opposées.

## La part native

La réception d'un message Firebase rejoint **L6-19**, la passe avec appareil.
Écris ici la logique de routage et de déduplication — elle se teste sans SDK — et
laisse le lien natif à cette session.

Tu as construit L7-01 pour que ce soit la seule pièce manquante côté client.
Garde cette discipline : ce qui se teste ici s'écrit ici, ce qui exige un
téléphone attend le téléphone, et la frontière entre les deux est nette.

**Et la déduplication existe déjà** par identifiant de proposition — complète-la
pour la source distante plutôt que d'en écrire une seconde. Un chauffeur
connecté qui reçoit à la fois le message temps réel et la notification ne doit
voir qu'une proposition.

Une proposition déjà expirée ou déjà attribuée, ouverte depuis une notification,
le dit — elle n'affiche pas un écran de décision pour une course qui n'est plus
à prendre.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

Lis les spécifications des tâches dépendantes : L3-07 (le cycle de proposition)
et L3-11 (la resynchronisation que tu vas étendre).

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J28.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une proposition retrouvée après une reconnexion, avec le temps qui reste
réellement — et une réponse qui dit « il n'y a rien » quand il n'y a rien, sans
faire attendre personne pour le découvrir.
```

---

## Après cette nuit

Il restera, en périmètre pilote : les habilitations (L8-01, L8-02 — sous revue humaine, et je
préfère les relire tôt), le back-office superviseur (L9-01 à L9-05, cinq tâches qui se ressemblent
et iront plus vite groupées), le mode dégradé (L6-16), la file de rejeu (L3-12), la facture
(L4-06), l'écran de recette (L5-07), les sauvegardes (L8-08), les scénarios de bout en bout
(L10-01), le déploiement (L0-07) et l'OTP (L1-09, suspendu à la passerelle SMS).

**La date a été révisée : premières courses vers le 13 octobre, marge au 20.** Le détail du calcul
et ce qui pourrait encore le compresser sont dans `amoa/06-jalons-et-pilote.md`.

Et **L6-19**, la passe avec un téléphone, dont trois dépendances natives dépendent maintenant. Elle
court en parallèle des nuits et ne coûte rien au calendrier si elle a lieu tôt.
