# Prompt de lancement — session de nuit J37

**Objectif** : rendre le déploiement fiable, et refermer la famille de défauts qui en a produit trois.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J36, D57/D58/D59, L0-10, spécifications L3-12 et L4-06 corrigées"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-13.md`.

Tes deux écarts d'hier ont eu raison contre moi. Celui sur la facture corrige
une phrase fausse que j'avais mise dans le prompt — tu as vérifié dans le dépôt
avant d'obéir, et c'est exactement ce que ce protocole demande. Continue.

## Périmètre de cette session

1. **L0-10** — la cohérence de la chaîne de configuration, et `deploy.sh`
2. **D57** — la facture qui part seule, et l'échec d'envoi qui se voit
3. **Le test instable** de `test_realtime_commit_hook.py`

## 1. L0-10 — ce que tu as trouvé hier a un frère, une couche plus haut

Ton défaut SMTP était le troisième de sa famille. Le mot de passe administrateur
le 11 septembre, le relais SMTP hier, et celui-ci que j'ai trouvé ce matin en
relisant `deploy.sh` :

Le script fait `. infra/env/.env`, examine `BABANA_MAPS_SEARCH_URL`, avertit si
elle pointe vers un simulateur — puis lance `npm run build:web` sans l'exporter.
Pas de `set -a`. Le bundle de production est construit sans aucune variable de
build. Regarde `apps/client/dist-web/bundle.js` : `MAPS_SEARCH_URL = false||undefined`
et `GOOGLE_WEB_CLIENT_ID = false||''`. Déployé tel quel, le Client web ne permet
ni de se connecter ni de chercher un lieu.

Le `Makefile` fait juste sur la même cible. Le chemin de développement est
correct, celui de production ne l'est pas — et c'est le seul que personne n'a
jamais parcouru.

**Le motif commun, et c'est lui qu'on ferme** : une variable a trois moments.
Déclarée (`infra/env/README.md`, `.env.example`), livrée (compose, export du
build, `_post_init_hook`), consommée (le code qui la lit). Le projet vérifiait
le premier et le troisième, séparément. Personne ne vérifiait le lien.

La spécification est dans `amoa/specs/L0-socle.md`. Trois points auxquels tenir.

**Les exceptions sont une liste nommée, jamais un défaut silencieux.**
`SMS_GATEWAY_*` attend L1-09, `FCM_*` attend un fournisseur. Chaque exception
porte la tâche qui la fermera, et une exception sans tâche fait échouer la suite —
sinon la liste devient l'endroit où l'on range ce qu'on ne veut pas regarder.

**Le contrôle porte sur le bundle produit, pas sur le fichier `.env`.** C'est
tout l'objet : le fichier était correct, la livraison ne l'était pas. Vérifier la
déclaration une quatrième fois ne trouverait rien.

**`deploy.sh` échoue, il n'avertit plus.** D43 appliquée à la chaîne de build :
un déploiement à moitié configuré s'arrête, il ne sert pas une page où l'on ne
peut rien faire.

Et le critère 7 est le plus important : un test qui échoue sur le `deploy.sh`
d'avant ta correction. Sinon rien ne prouve que tu as fermé ce défaut-là.

## 2. D57 — la facture part seule

J'avais spécifié « envoi à la demande, un email par course serait subi ». C'est
renversé : personne ne réclame une facture dont il ignore l'existence, et une
facture réclamée arrive trois jours après, quand plus personne ne sait ce qui a
été payé. Sur des courses en espèces, l'écrit immédiat protège d'abord le
chauffeur.

Elle part donc automatiquement à l'encaissement. Le bouton manuel reste, comme
rattrapage.

**Et la condition compte autant que l'automatisme : un échec d'envoi doit se
voir.** Tu l'as écrit toi-même hier soir, c'était ta question du soir, et elle
était juste. Un envoi automatique qui échoue en silence est pire qu'un envoi
manuel : il retire le dernier humain qui aurait pu constater l'absence. Ta panne
SMTP n'a été trouvée que parce que quelqu'un a cliqué puis est allé regarder
Mailpit — aucun superviseur ne fera ça tous les jours.

Où ça se voit, c'est à toi de le décider : là où un superviseur regarde déjà.
Le test prouve la visibilité **en provoquant l'échec**, pas en vérifiant qu'un
envoi réussi réussit.

Attention au point d'accroche, et c'est la distinction que tu as posée hier
(D58) : l'envoi d'un email n'est pas une écriture PostgreSQL. S'il part depuis
le savepoint et que l'encaissement échoue ensuite, le client reçoit la facture
d'une course qui n'a pas eu lieu. Range-le du bon côté.

## 3. Le test instable

`test_realtime_commit_hook.py`, les deux tests suspendus à un `time.sleep(1.0)`.
Tu as eu raison de le signaler plutôt que de le réparer à l'aveugle. Mais
`CLAUDE.md` est catégorique, et il part avec ce lot.

**Il ne se répare pas en allongeant l'attente** : attendre plus longtemps rend
l'échec plus rare, pas moins possible, et déplace le problème dans six mois. Ce
que ces tests veulent prouver est qu'un appel *n'a pas* eu lieu — ça se constate
sur un fait déterministe (le point d'accroche n'a rien enregistré), pas en
laissant passer une seconde pour voir si quelque chose arrive.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

**Et le point 9** : D57 change ce qu'un superviseur voit après un encaissement.
Ouvre l'écran, provoque un échec d'envoi, et dis ce que tu vois — pas ce que le
test vérifie.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J37.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un `deploy.sh` qui refuse de partir plutôt que de servir un Client web où l'on ne
peut pas se connecter. Et un superviseur qui apprend qu'une facture n'est pas
partie sans avoir à le deviner.
```

---

## Après cette nuit

Restera, en périmètre pilote : les sauvegardes avec restauration prouvée (L8-08), les scénarios de
bout en bout (L10-01), et l'OTP (L1-09, suspendu à la passerelle SMS).

Plus **L6-19**, la demi-journée avec un téléphone.

**Vos démarches, par ordre d'urgence :**

| Démarche | Ce qu'elle bloque | Latence propre |
|---|---|---|
| **Passerelle SMS** | L1-09 + notification du contact d'urgence | jours à semaines, non compressible |
| **Relais SMTP** | `deploy.sh` refuse de partir sans lui | vérification du domaine, SPF/DKIM — comptez plusieurs jours |
| **Compte Google Cloud** | `deploy.sh` refuse de partir sans lui | heures |
| **VPS + DNS** | la démonstration, puis L0-07 | heures |
| **Demi-journée avec un téléphone** | L6-19 — aucun chauffeur ne peut s'inscrire sans | une demi-journée |
| **Validation du plan comptable** | rien techniquement — mais une facture réelle porterait des comptes provisoires | à votre comptable |

Le détail est dans `amoa/06-jalons-et-pilote.md`.
