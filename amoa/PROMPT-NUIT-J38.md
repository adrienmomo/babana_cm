# Prompt de lancement — session de nuit J38

**Objectif** : le dernier point long du périmètre pilote, et deux replis dangereux retirés.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J37, D60/D61, L3-14 au périmètre pilote, L0-05 daté hors périmètre"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-14.md`.

Trois choses réussies hier soir méritent d'être dites : le test instable réparé
par un fait déterministe plutôt que par une attente plus longue, l'exception
`FCM_*` de ma spécification vérifiée dans le dépôt avant d'être recopiée — elle
était fausse — et deux garde-fous sur la chaîne de build au lieu d'un.

## Périmètre de cette session

1. **L8-08** — sauvegardes et restauration
2. **D60** — le bouton d'envoi de facture ne commite plus la requête
3. **D61** — les adresses de serveur sortent des replis suffisants

## 1. L8-08 — le dernier point long

`infra/production/backup.sh` et `restore.sh` existent depuis L0-07, jamais
exécutés. La tâche n'est pas de les écrire, c'est de les rendre vrais.

**Une sauvegarde jamais restaurée n'est pas une sauvegarde**, et c'est écrit
dans la définition de fin de mise en production. Ce que tu peux prouver cette
nuit : sauvegarder la base et le stockage de documents, puis **restaurer dans un
conteneur neuf** et vérifier que les données sont là — pas que le script se
termine sans erreur. Une course encaissée, sa facture, un document de chauffeur,
un solde de compte courant : quatre choses à retrouver, pas un code de retour.

Ce que tu ne peux pas prouver, et c'est très bien : la restauration sur un hôte
vierge, chez un autre hébergeur. Ce geste-là m'appartient, et le journal de
`docs/operations/production.md` l'attend. Dis clairement où passe la frontière.

**Redis n'est délibérément pas sauvegardé** — c'est l'invariant 1 : le service
temps réel ne possède aucune donnée durable, et une reprise se reconstruit depuis
Odoo. Si tu trouves que ce n'est pas vrai, c'est un écart et il vaut une nuit.

**Et la sauvegarde est chiffrée avant de sortir de la machine.** Elle contient
des pièces d'identité de chauffeurs.

## 2. D60 — lever n'est pas une façon d'afficher

Ton correctif du bouton est juste dans son diagnostic et fonctionne. Mais
`Cursor.commit()` exécute au passage les points d'accroche au commit en attente :
un gestionnaire qui commite puis lève déclenche les effets externes d'une requête
qui se termine en erreur. C'est D32 pris par l'autre bout, et c'est le seul
`commit()` sur le curseur d'une requête dans tout le dépôt.

Rien ne s'enregistre avant ce bouton aujourd'hui. La garantie tient donc au fait
que personne n'a ajouté de ligne au-dessus — c'est-à-dire à rien.

**Ne lève pas.** Une action qui renvoie une notification (`ir.actions.client`)
affiche le même message et laisse la transaction se terminer normalement, avec
l'écriture dedans. L'erreur n'avait pas besoin d'être une exception, elle avait
besoin d'être visible.

**Et couvre-la par un test.** Aujourd'hui le seul test qui passe par le bouton
emprunte le chemin du succès ; les deux tests d'échec appellent la méthode
interne. Tu as trouvé ce défaut à l'œil et son correctif est reparti sans filet —
c'est la politique de non-régression qui l'exige : tout défaut corrigé donne
d'abord un test qui échoue.

## 3. D61 — un repli plausible est pire qu'une absence

`tools/config-coherence/variables.ts` range `BABANA_API_URL` et
`BABANA_REALTIME_WS_URL` parmi les replis suffisants, parce que leur valeur par
défaut est l'adresse de production réelle. C'est vrai, et c'est le problème :
**un binaire de recette construit sans ces variables écrirait de vraies courses
dans la base du pilote**, sans que rien ne le signale.

C'est D43 appliqué à une adresse qu'on a jugée inoffensive parce qu'elle est
juste. L'absence se voit ; la valeur plausible se croit.

Elles sortent de la liste, et une adresse manquante fait échouer plutôt que
deviner. Les seuils, délais et plafonds gardent leurs replis — ce sont des
réglages, pas des destinations. La distinction mérite d'être écrite dans le
commentaire de la liste, sinon la prochaine adresse y retournera.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

**Et le point 9** : trois nuits de suite, ouvrir un écran a rapporté plus qu'une
suite verte. D60 change ce qu'un superviseur voit quand un envoi échoue — clique
le bouton, provoque l'échec, recharge la page, et dis ce que tu vois.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J38.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une base restaurée dans un conteneur neuf où je retrouve une course encaissée,
sa facture, un document de chauffeur et un solde. Et un bouton qui dit qu'il a
échoué sans commiter quoi que ce soit.
```

---

## Après cette nuit

Périmètre pilote restant : **L3-14** (résilience — entrée au périmètre hier), **L10-01**
(scénarios de bout en bout), **L1-09** (OTP, suspendu à la passerelle SMS), et **L6-19** (la
demi-journée avec un téléphone).

L0-05 (intégration continue) reste **hors périmètre, par choix daté** — elle automatise une
discipline que les nuits tiennent déjà, et redeviendra nécessaire le jour où quelqu'un d'autre
touchera au dépôt.

**Et la démonstration n'attend plus que le VPS.** En simulé, fermée par `WEB_ALLOWED_IPS`, sans
Google Cloud ni relais SMTP — le déroulé est dans `amoa/07-demonstration.md`.
