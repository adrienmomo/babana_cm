# Prompt de lancement — session de nuit J40

**Objectif** : rendre joignable l'écran qui approuve un chauffeur, puis vérifier l'invariant 1.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J39, D64 (point d'entrée public du stockage), D61 étendue, L3-14 en J40"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-16.md` et
`amoa/01-architecture.md` §9 octies.

Ton écart d'hier est le plus important depuis le début du projet. Tu as trouvé,
en cliquant sur un bouton, que l'écran d'approbation d'un chauffeur n'aurait
pas fonctionné le premier jour du pilote — et qu'un test vert le couvrait
depuis des semaines parce qu'il s'exécutait du bon côté de la frontière réseau.

## Périmètre de cette session

1. **D64** — le point d'entrée public du stockage
2. **D61 étendue** — le repli `https://babana.cm` de `share.py`
3. **L3-14** — le test de résilience

## 1. D64 — l'adresse qui signe n'est pas celle qui écrit

Arbitré : une route publique dédiée via Caddy. Le serveur écrit sur le point
d'entrée interne ; l'URL signée qu'il renvoie porte le point d'entrée public.

Quatre points auxquels tenir.

**La route n'expose que l'API S3 de lecture, jamais la console
d'administration.** MinIO sert les deux sur des ports différents — c'est un
critère d'acceptation, pas une précaution : un appel à la console depuis
l'extérieur doit échouer, et un test doit le prouver, au même titre que le
critère 1 de L1-05 qui prouve déjà qu'un objet n'est pas lisible sans signature.

**Aucun repli d'un point d'entrée vers l'autre** (D43). Une configuration
incomplète échoue bruyamment ; elle ne retombe pas sur l'adresse interne, qui
produirait exactement le défaut d'hier en silence.

**Et le nouveau critère 6 est celui qui compte** : l'URL signée est vérifiée
**depuis l'extérieur du réseau interne**, par un client qui ne résout aucun nom
de service. Pas depuis un conteneur. C'est le critère que les cinq précédents
n'exerçaient pas — ils s'exécutaient tous du bon côté.

**Puis ouvre l'écran, par le vrai chemin.** Le bouton « Voir la pièce », dans un
navigateur, sur le formulaire d'un chauffeur en attente. Hier tu as vu le PDF
par un contournement que tu as eu raison de nommer ; ce soir c'est le bouton
qui doit marcher.

La sécurité reste portée par la signature et son expiration à cinq minutes —
c'était déjà le modèle écrit dans `storage.py`, il lui manquait d'être
joignable. Ne la remplace pas par une liste d'adresses : un chauffeur doit
pouvoir atteindre ses propres pièces depuis n'importe quel réseau mobile.

## 2. D61 étendue — une règle ne vaut pas que dans le fichier où on l'a trouvée

`controllers/share.py::_share_base_url()` retombe sur `https://babana.cm` si
`BABANA_DOMAIN` est absente. Adresse de production en repli, exactement ce que
D61 interdit — je ne l'avais fait constater que sur `apps/*/config.ts`.

Le risque réel est faible, `deploy.sh` exige déjà cette variable. Corrige quand
même, et **balaie le reste** : s'il existe un troisième repli de ce genre
ailleurs, c'est ce soir qu'il se trouve, pas dans trois semaines sur une
troisième découverte isolée.

## 3. L3-14 — la seule vérification de l'invariant 1

Tuer le service temps réel en pleine course, redémarrer, la course se retrouve
et se termine. C'est écrit dans `CLAUDE.md` depuis le premier jour comme l'une
des quatre suites qui protègent l'ensemble, et c'est la seule qui vérifie
l'invariant fondateur : le service ne possède aucune donnée durable, tout se
reconstruit depuis Odoo.

Deux choses à ne pas confondre. **La file de rejeu (L3-12) survit au
redémarrage — c'est voulu, et ce n'est pas de l'état métier.** L'état de la
course, lui, doit se reconstruire. Si le test passe parce que Redis a gardé
quelque chose qu'il n'aurait pas dû garder, il ne prouve rien.

**Et ce test doit échouer si l'invariant est violé.** Comme pour L3-13, vérifie-le
une fois en cassant délibérément la reprise — sinon il ne prouve rien, il
accompagne.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

**Et le point 9** : le bouton « Voir la pièce », cliqué dans un navigateur, sur
le vrai chemin. C'est la tâche.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J40.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un permis qui s'affiche quand on clique dessus, depuis un navigateur ordinaire.
Et une course qui survit à la mort de son service.
```

---

## Après cette nuit

Périmètre pilote restant : **L10-01** (scénarios de bout en bout), **L1-09** (OTP, suspendu à la
passerelle SMS) et **L6-19** (la demi-journée avec un téléphone).

**Prévoyez un quatrième nom DNS** pendant que vous êtes chez le registrar — `docs.babana.cm` ou
équivalent, pour la route de stockage. Il s'ajoute à l'apex, `api.` et `admin.`.

**Un geste reste le vôtre** : restaurer une sauvegarde sur un hôte vierge. Tant que le journal de
`docs/operations/production.md` §7 est à sa ligne vide, L8-08 n'est pas finie.
