# Prompt de lancement — session de nuit J27

**Objectif** : qu'un chauffeur reçoive une course quand son application est fermée.

**Le dernier blocage dur côté chauffeur.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J26, L6-19 passe native, le dossier refusé se dit avec son motif"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-04.md`.

Ton arrêt après L6-15 était le bon geste, et ton rapport en a fait un passage de
relais plutôt qu'une interruption — les quatre points d'attention que tu as
consignés pour L7-01 et L7-04 sont le périmètre de cette nuit.

## Périmètre de cette session

1. **Le dossier refusé se dit** — statut et motif dans la session, trois
   situations distinctes à l'écran d'attente
2. **L7-01** — Firebase Cloud Messaging, cycle de vie des jetons d'appareil
3. **L7-04** — notification de proposition au chauffeur hors connexion

**Si le lot ne passe pas en entier, arrête-toi après L7-01** — un jeton
d'appareil sans notification qui l'utilise reste utile, l'inverse ne l'est pas.

## Le dossier refusé — petit, et il aurait mal paru

Un chauffeur `rejected` ou `suspended` est aujourd'hui routé comme un `pending` :
il redépose des pièces qui seront refusées de nouveau, sans savoir pourquoi.

Trois situations, trois écrans, parce qu'elles n'appellent pas la même action :
**en cours de validation** — rien à faire qu'attendre ; **incomplet** — il manque
telle pièce, nommée ; **refusé** — avec le motif, et le chemin pour corriger et
resoumettre.

C'est la règle déjà écrite dans ta spécification, appliquée cette fois au dossier
entier : « en cours de validation » n'est pas une information.

## L7-01 — le piège est le cycle de vie, pas l'intégration

**Un jeton d'appareil périmé qui reste en base envoie dans le vide et fait croire
que le chauffeur a été prévenu.** C'est le défaut qui compte : il ne casse rien
visiblement, il ment silencieusement sur une notification qu'on croit délivrée.

Il se nettoie **quand le service le signale** — retour d'envoi, jeton invalidé —
pas quand quelqu'un y pense, et pas par un balayage périodique qui devine.

**D19 et D43 s'appliquent** : simulateur par défaut, aucune branche
conditionnelle dans le code métier, le vrai service branché par configuration —
et **aucune valeur par défaut qui retombe sur le vrai fournisseur**. Sans cette
dernière règle, on découvrirait qu'on envoie de vraies notifications depuis un
environnement de développement, ou l'inverse, en regardant le trafic réseau.

Un appareil peut porter plusieurs comptes, un compte plusieurs appareils. Le
modèle doit le supporter dès maintenant, sinon la première réinstallation d'un
chauffeur produira un doublon silencieux.

## L7-04 — la notification double le message, elle ne le remplace pas

**Le délai d'acceptation court depuis l'émission de la proposition** (L3-07), pas
depuis l'ouverture de l'application. Un chauffeur qui ouvre sa notification vingt-
cinq secondes plus tard doit voir un compte à rebours honnête — cinq secondes,
pas trente fraîches.

`ProposalScreen` revalide déjà auprès du serveur (D49) : c'est le bon point
d'accroche, et il évite d'avoir à faire confiance à l'horodatage porté par la
notification.

**La déduplication existe déjà côté app** par identifiant de proposition —
complète-la pour la source distante plutôt que d'en écrire une seconde. Un
chauffeur connecté qui reçoit à la fois le message temps réel et la notification
ne doit voir qu'une proposition.

Et une proposition déjà expirée ou déjà attribuée, ouverte depuis une
notification, doit le dire — pas afficher un écran de décision pour une course
qui n'est plus à prendre.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

Lis les spécifications des tâches dépendantes : pour L7-01, lis L7-02 et L7-03 ;
pour L7-04, lis L3-07.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J27.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une proposition qui réveille un chauffeur dont l'application est fermée, avec un
compte à rebours qui dit la vérité.
```

---

## Après cette nuit

Il restera, en périmètre pilote : les habilitations (L8-01, L8-02 — sous revue humaine, et je
préfère les relire tôt), le back-office superviseur (L9-01 à L9-05), le mode dégradé (L6-16), la
file de rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les sauvegardes (L8-08), les
scénarios de bout en bout (L10-01) et le déploiement (L0-07).

Plus **L6-19**, la passe native — qui n'attend qu'un téléphone et une demi-journée, et dont dépend
l'inscription d'un chauffeur réel.

Le détail et les dates : **`amoa/06-jalons-et-pilote.md`**. Je referai le calcul si une troisième
nuit d'affilée s'arrête avant la fin de son lot — mieux vaut une date corrigée qu'une date qui
vieillit toute seule.
