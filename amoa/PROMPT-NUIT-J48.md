# Prompt de lancement — session de nuit J48

**Finir L6-18.** Le Client web ne sait ni se connecter, ni afficher une carte, et il range sa
session en clair.

---

## À faire avant de lancer

**De votre côté, avant la nuit** — sans ça, deux des trois pièces ne peuvent pas être faites :

1. Un projet Google Cloud, et dedans :
   - un **identifiant client OAuth « Web »**, avec `https://babana.dev` et `http://localhost:8080`
     en origines JavaScript autorisées ;
   - une **clé API Maps JavaScript**, restreinte à ces mêmes domaines.
2. Les deux valeurs déposées dans `code/infra/env/.env` du poste de développement.

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: L6-18 livrée en partie, D74 -- le registre suit aussi les livraisons partielles"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/01-architecture.md` §9 sexdecies et le
registre du §13, puis la spécification de L6-18 (`amoa/specs/L6-mobile.md`) en
entier, et `amoa/09-recette-babana-dev.md`.

## Pourquoi cette nuit existe

L6-18 a été commitée `(part)` il y a quatre semaines. La nuit qui l'a livrée a
été scrupuleuse : elle a nommé sa limite dans le message de commit, dans
`webpack.config.js`, et dans chacun des deux bouchons qu'elle posait. **Rien n'a
été caché, et rien n'a été repris.** C'est mon défaut de suivi, pas le sien — et
il a fallu vouloir déployer sur un second domaine pour s'en apercevoir.

Le bundle avait pourtant été vérifié comme s'exécutant réellement (D38). La
vérification était juste ; elle s'arrêtait à l'écran d'accueil. **Ouvrir un écran
n'est pas s'en servir.**

## Périmètre — les trois pièces manquantes de L6-18

**1. Le stockage de session web. C'est le plus urgent, et c'est un défaut de
sécurité.**

`webpack-stubs/react-native-keychain.web.js` écrit en clair dans le stockage du
navigateur. Son propre commentaire dit « à remplacer par quelque chose de
réellement sûr avant tout déploiement ». Et **D39 tranche déjà la question** :
aucune session n'est persistée sur le web, la session vit **en mémoire
seulement** — fermer l'onglet déconnecte, rouvrir demande une reconnexion.

Ce n'est donc pas « chiffrer mieux », c'est **ne rien persister**. Et la
dégradation se signale à l'utilisateur, elle ne se masque pas (la spécification
l'exige au même endroit).

**2. Le flux OAuth web.** `packages/api-client/src/auth/web.ts`, le fichier que
la spécification nomme et qui n'existe pas. Deux points auxquels tenir :

- **L'échange contre le jeton applicatif est identique** (L1-01,
  `exchangeGoogleIdToken`). Seule l'obtention de l'ID token diffère. Si tu te
  retrouves à toucher l'échange, c'est que le découpage est mauvais.
- **Les identifiants clients Web et Android sont distincts**, tous deux dans la
  configuration, tous deux acceptés côté Odoo (`GOOGLE_OAUTH_CLIENT_IDS` en
  porte déjà une liste).

**3. Le fournisseur de carte web.** `packages/maps/src/providers/web/`, la
troisième implémentation derrière la même interface que le fournisseur natif.

C'est le point où la spécification est la plus exigeante, et elle a raison :
**aucun écran ne change.** Si un écran doit être modifié pour fonctionner en web,
c'est l'abstraction qui est incomplète, et c'est elle qu'il faut corriger. Le
bouchon actuel existe parce que `activeProvider.ts` ne sait pas encore choisir un
fournisseur selon la plateforme — c'est ce choix qu'il faut construire, puis
retirer les deux alias de `webpack.config.js`.

À Douala l'adresse formelle n'existe quasiment pas : la désignation d'un point
sur la carte est le chemin le plus court, et sans carte le Client web ne
démontre rien.

## Ce que j'attends en plus du code

**Les dégradations signalées.** Trois fonctions sont absentes ou dégradées sur le
web — notifications, capture en arrière-plan, lien profond — plus la session non
persistée. Un bandeau discret qui le dit. La spécification est explicite :
signalées, jamais masquées.

**Et le point 9, appliqué à ce que la vérification précédente n'a pas fait** :
ouvre le Client web dans un navigateur, **connecte-toi pour de vrai**, désigne un
point sur une vraie carte, demande une course, va jusqu'au bout. Puis ferme
l'onglet et rouvre : tu dois être déconnecté. Dis ce que tu vois à chaque étape.

C'est cette nuit que « le bundle s'exécute » devient « quelqu'un s'en est servi ».

## Ce qui reste hors périmètre

Le déploiement lui-même. `amoa/09-recette-babana-dev.md` le décrit et il attend
cette nuit ; n'y touche pas.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, `make test` en entier.

**Et si tu ne peux livrer qu'une partie** — c'est arrivé la première fois, en
toute honnêteté — dis-le dans le rapport sous la forme « L6-18 reste partielle :
il manque X », pas seulement dans un message de commit. C'est D74, écrite hier
précisément parce que la mention dans le commit n'a été reprise par personne.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J48.md`, et complète la passe de clôture de J41.

Et la question habituelle : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une connexion réelle depuis un navigateur, une carte sur laquelle on désigne un
point, et un onglet fermé qui déconnecte.
```

---

## Après cette nuit

Le déploiement de recette sur `babana.dev` — `amoa/09-recette-babana-dev.md` porte la
configuration nginx, la plage de ports dédiée et la surcharge Compose, et
`amoa/PROMPT-SERVEUR-RECETTE.md` le prompt à lancer sur le VPS.

**Et le compte Google Cloud ouvert pour cette nuit sert aussi le pilote** : c'est l'une des six
démarches de `08-passation-pilote.md`, faite d'avance.
