# Prompt de lancement — session de nuit J12

**Objectif** : corriger la comptabilité, puis poser la première pierre des applications.

**Onze nuits de travail sont invisibles.** À partir de cette nuit, ça change.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J11, D34 la créance ne se solde qu'à hauteur du reçu"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-20.md`.

Son §1 décrit une erreur de ma spécification que tu as implémentée fidèlement,
et qui fait dire à la comptabilité le contraire du compte courant. C'est la
première correction de la nuit.

## Périmètre de cette session

**Corrections d'abord.**

1. **D34** — l'écriture comptable ne solde la créance qu'à hauteur du montant
   réellement reçu
2. **`GET /drivers/me/cash`** — prévu par le contrat C-01, jamais construit ; tu
   l'as signalé toi-même

**Puis les fondations des applications.**

3. **L6-01** — abstraction carte et navigation (C3)
4. **L6-02** — connexion Google Sign-In dans les deux apps

**Pas d'écran métier cette nuit.** Ni la course, ni la recette. Ces deux tâches
posent ce sur quoi tous les écrans s'appuieront ; les écrire avant serait poser
quinze écrans sur des fondations non testées.

## D34 — le détail

L'écriture crédite aujourd'hui la créance du **montant attendu en entier**, et
débite l'écart sur un compte dédié. En comptabilité, le chauffeur ne doit donc
plus rien — alors que D29 et le compte courant disent qu'il doit encore, et que
ces 5 000 pèsent sur son plafond.

La dérive se voit à la remise suivante : il remet les 5 000 manquants, la
créance est créditée de 5 000 de plus, et passe en **solde créditeur**. Les
livres affirment que l'entreprise doit de l'argent à un chauffeur qui lui en
devait.

**Écriture correcte** : caisse au débit, créance au crédit, **pour le seul
montant compté**. Le reliquat reste dû au bilan, du même montant que celui resté
au compte courant.

Le compte d'écart n'intervient qu'au moment où une **décision humaine éteint la
dette** — retenue ou ajustement, L5-06 — parce que c'est le seul moment où la
créance cesse d'exister. Le traitement par défaut de D29 ne produit donc aucune
écriture : ne rien décider, c'est laisser la dette où elle est.

Deux tests, et le second est celui qui compte :
- la créance restant due égale exactement le solde du compte courant ;
- **45 000 dus, 40 000 remis, puis 5 000 remis** — créance à zéro à la fin,
  jamais négative.

Tes tests précédents étaient verts parce qu'ils vérifiaient mes deux critères,
et mes deux critères étaient ambigus. C'est le risque dont je t'avertis depuis
le début de ce lot ; il s'est réalisé sur moi, pas sur toi.

## Le plan comptable — ce que j'en fais

Ton constat était juste et ton refus de détourner un compte générique existant
aussi. Les comptes restent, marqués provisoires, et la validation par un
comptable entre dans les prérequis.

**Mais cela appartenait à `amoa/questions/`, pas au rapport.** Une dépendance
externe qui se comporte autrement que la spécification le suppose est un motif
d'arrêt explicite, et créer trois comptes qui apparaîtront dans de vrais états
financiers en est un. Ce n'était pas un contournement silencieux — tout était
écrit — mais un écart déposé est arbitré le lendemain matin, un paragraphe de
rapport est archivé. C'est une question d'adresse.

## L6-01 et L6-02 — points d'attention

**L6-01, la frontière est le but de la tâche.** Aucun écran n'importe jamais le
SDK de carte : tout passe par `@babana/maps`. C'est une frontière de lint
(`CLAUDE.md`), et c'est ce qui permettra de changer de fournisseur (D13). En v1,
la navigation est un lien profond vers Google Maps (D12) — mais l'interface doit
déjà prévoir le guidage embarqué, sinon on la réécrira entièrement en v2.

**Les différences de plateforme vivent dans les paquets partagés, jamais dans
les écrans.** L'app Client s'exporte en web (D22). Un `Platform.OS === 'web'`
dans un écran annonce quinze écrans dans le même état six mois plus tard.

**L6-02, le jeton.** Sa forme est un contrat depuis D23
(`AccessTokenClaimsSchema`) — importe-le, ne le redéclare pas. Le rafraîchissement
est transparent : l'app ne doit jamais montrer une erreur d'authentification pour
un jeton simplement expiré. Le réseau de Douala est intermittent par hypothèse de
travail, pas par exception.

**Et l'empreinte de signature.** L'identifiant client OAuth Android est lié à
l'empreinte du certificat. Il en faut une pour le développement et une pour la
publication ; oublier la seconde produit une connexion qui marche en
développement et échoue en production. Documente ce qui est nécessaire côté
console Google plutôt que de le supposer fait.

## Ce qu'il faudra me dire dans le rapport

À quoi ressemble un écran, concrètement, une fois ces deux tâches posées. Pas
une maquette — la structure : qu'est-ce qu'un écran importe, de quoi il dépend,
combien de lignes il fait pour afficher une carte et un bouton.

C'est ce qui me permettra de calibrer le reste du lot L6, et je n'ai aucune
idée aujourd'hui de la réponse.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport. La discipline a tenu cette
nuit ; c'est le rythme à garder.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

`make reset` avant de déclarer les corrections finies. Les tâches L6 ne touchent
pas Odoo, mais la correction comptable si.

Lis les spécifications des tâches dépendantes : pour L6-01, lis L6-06 et L6-07 ;
pour L6-02, lis L6-03.

## Rapport

`amoa/rapport-nuit-J12.md`, une entrée par tâche, commitée avec elle.

## Ce que j'attendrai demain matin

Une créance qui tombe à zéro après deux remises partielles, jamais en dessous.
Et une carte qui s'affiche dans les deux applications, sans qu'aucun écran ne
sache quel fournisseur la dessine.
```

---

## Après cette nuit

Le lot L6 sera ouvert, et c'est le plus long du projet. Il faudra ensuite trancher la question des
maquettes : D20 accepte le générique pour le pilote, décision prise quand le produit était abstrait.
Elle mérite d'être reconfirmée maintenant qu'un écran va exister.

Resteront côté serveur : L3-12 (la file de rejeu), L4-06 (la facture), et la seconde moitié du lot
temps réel.

Et deux démarches à lancer, toutes deux à délai subi :

- **La validation du plan comptable** par quelqu'un qui connaît le SYSCOHADA. Tant que ce n'est pas
  fait, les écritures produites sont plausibles et fausses.
- **La vérification développeur Android**, plutôt que le compte Play.
