# Prompt de lancement — session de nuit J26

**Objectif** : qu'un vrai chauffeur puisse entrer dans le système, et recevoir une course quand son
application est fermée.

**Deux blocages durs du pilote.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J25, D12 réexaminée et maintenue, protocole de mesure GPS, notification qui constate"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-03.md`.

Ton écart de L6-05 a touché une décision du premier jour. Elle a été rouverte,
examinée et maintenue — le raisonnement est au §4 bis de `01-architecture.md`,
et il te sera utile si la question revient.

## Périmètre de cette session

1. **La notification qui constate** — « dernière position envoyée il y a N min »
   plutôt qu'une affirmation de suivi actif
2. **L6-15** — inscription chauffeur, téléversement des documents, écran
   d'attente de validation
3. **L7-01** — intégration Firebase Cloud Messaging, cycle de vie des jetons
   d'appareil
4. **L7-04** — notification de proposition au chauffeur hors connexion

**Si le lot ne passe pas en entier, arrête-toi après L6-15.**

## La notification — ce qu'elle change

Sans service de premier plan, rien ne garantit que la capture continue. Une
notification qui dit « suivi actif » affirme donc ce qu'elle ne peut pas tenir.

Qu'elle affiche **quand la dernière position est réellement partie**. Elle cesse
d'affirmer et se met à constater — et elle devient le diagnostic dont la mesure
GPS aura besoin : celui qui tient le téléphone voit si la capture s'est arrêtée
sans avoir à interroger le serveur.

## L6-15 — le chemin par lequel un chauffeur entre

Aujourd'hui il n'y en a aucun. C'est un blocage dur, pas une finition.

**Les documents ne sont jamais servis par une URL publique** (§9, et L1-05) —
accès signé, à durée limitée. Un permis de conduire et une pièce d'identité sont
les données les plus sensibles que ce produit manipulera.

**L'écran d'attente dit où en est le dossier**, précisément. « En cours de
validation » n'est pas une information ; « il manque votre permis » en est une.
Un chauffeur qui ne sait pas ce qu'on attend de lui appelle, ou abandonne.

**Le téléversement doit survivre à une coupure** — c'est le cas courant, et un
chauffeur qui doit reprendre une photo de permis à cause du réseau ne
recommencera pas trois fois.

**Le refus se dit avec son motif**, et laisse un chemin : corriger et
resoumettre. Un refus sans recours transforme un dossier incomplet en chauffeur
perdu.

## L7-01 et L7-04 — sans elles, le pilote ne fonctionne pas

Un chauffeur dont l'application est fermée ne reçoit aucune proposition. Et
l'application sera fermée la plupart du temps.

**Firebase est une dépendance externe** : garde le principe D19 — le simulateur
par défaut, aucune branche conditionnelle dans le code métier, et le vrai
service branché par configuration.

**Le cycle de vie des jetons d'appareil est le piège de L7-01.** Un jeton
change — réinstallation, effacement des données, rotation par le système. Un
jeton périmé qui reste en base envoie des notifications dans le vide et fait
croire que le chauffeur a été prévenu. Il se nettoie quand le service le
signale, pas quand quelqu'un y pense.

**Et pour L7-04, la notification ne remplace pas le message temps réel, elle
le double.** Le délai d'acceptation court à partir de l'émission de la
proposition, pas de l'ouverture de l'application — un chauffeur qui ouvre sa
notification vingt-cinq secondes plus tard doit voir un compte à rebours
honnête, pas trente secondes fraîches.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

Lis les spécifications des tâches dépendantes : pour L6-15, lis L1-05 et L9-03
(la validation côté back-office) ; pour L7-04, lis L3-07.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J26.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un chauffeur qui s'inscrit, dépose ses documents, et voit où en est son dossier.
Et une proposition qui le réveille quand son application est fermée.
```

---

## Après cette nuit

Il restera, en périmètre pilote : les habilitations (L8-01, L8-02 — sous revue humaine, et je
préfère les relire tôt), le back-office superviseur (L9-01 à L9-05), le mode dégradé (L6-16), la
file de rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les sauvegardes (L8-08), les
scénarios de bout en bout (L10-01) et le déploiement (L0-07).

Le détail et les dates : **`amoa/06-jalons-et-pilote.md`**.

Et cinq démarches, dont la première n'attend plus que vous : **la mesure GPS en arrière-plan**, une
demi-journée avec un vrai téléphone, protocole au §2. Elle conditionne une décision d'architecture
et elle ne s'obtient nulle part ailleurs.
