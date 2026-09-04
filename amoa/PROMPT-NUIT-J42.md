# Prompt de lancement — session de nuit J42

**La dernière, cette fois.** Ce qu'un pilote ne peut pas rattraper.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J41, D67 -- L8-09 entre au périmètre pilote"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-18.md`.

Ta passe de clôture d'hier est le meilleur document que ce projet ait produit —
plus utile que les spécifications pour savoir où en est réellement le dépôt. Et
ton avertissement final était juste : j'avais laissé L8-09 hors du périmètre
pilote, et j'avais tort. Elle y entre, et c'est cette nuit.

Une note aussi : tu n'as touché `amoa/` que par ton écart et ton rapport. Merci.

## Périmètre de cette session

1. **Rejouer `npm test` en entier**, avant toute autre chose
2. **L8-09** — le journal d'audit immuable

## 1. D'abord, la suite complète

`npm test` n'a jamais tourné d'un bout à l'autre sans coupure hier. Trois échecs
sont apparus dans la portion interrompue — `concurrency/select-driver-replay`,
`http-contract::createRideShare`, `http-contract::revokeRideShare` — dans des
fichiers que tu n'avais pas touchés, avec des durées aberrantes.

Ton diagnostic (machine en veille) est probablement juste. **Mais le point 3 de
la définition de fini n'est pas satisfait pour le lot d'hier**, et c'est la
première chose à trancher : `npm test` en entier, sans coupure, sur cet
environnement.

Si les trois échecs reviennent, ils ne sont pas environnementaux — et ils
passent devant L8-09 dans le périmètre de la nuit.

## 2. L8-09 — ce qu'un pilote ne peut pas rattraper

La spécification est dans `amoa/specs/L8-securite.md`, et elle est complète.
Quatre points auxquels tenir.

**Le point d'accroche existe déjà.** `_babana_journalize()` est appelé à chaque
transition depuis le premier jour, et son commentaire annonce cette tâche par
son nom. Appuie-toi dessus plutôt que de repartir des appelants — et vérifie
que la liste des événements obligatoires de la spécification est bien couverte
par ce point unique. **Si un événement de la liste ne passe pas par là, c'est
un écart, pas un oubli à combler en silence** : chaque mouvement de compte
courant, chaque remise et sa validation, chaque changement d'état de chauffeur,
chaque ajustement, chaque accès à un document chauffeur.

Ce dernier est le moins évident et le plus important : un accès à une pièce
d'identité se journalise, et il passe par `documents.py`, pas par une
transition.

**Immuable veut dire immuable, y compris pour un administrateur.** Interdit au
niveau du modèle, pas par une règle d'enregistrement — les règles ne
s'appliquent pas en `sudo`, et D54 t'a déjà montré ce que ça coûte. Un test qui
tente la modification en administrateur et échoue est le critère 2.

**Le journal ne fait jamais échouer l'opération métier.** C'est écrit dans la
spécification et ça vaut d'être répété : un journal qui bloque les courses
serait désactivé le premier jour d'incident. Si son écriture échoue,
l'opération se poursuit et l'échec se signale ailleurs — le même principe que
la réconciliation d'engagement, qui répare et dénonce.

**Attention au point d'accroche.** Le journal est une écriture PostgreSQL
ordinaire : il vit dans la transaction, avec l'opération qu'il décrit (D58),
jamais au commit. Mais il ne doit pas la faire échouer — les deux exigences se
concilient, et c'est le seul endroit délicat de cette tâche.

**Et le point 9** : une vue back-office consultable et filtrable, réservée aux
administrateurs. Ouvre-la, filtre sur une course du jeu de démonstration, et
dis si quelqu'un qui arbitre un litige y trouve ce qu'il cherche. C'est le seul
usage réel de cet écran.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale — **et cette fois, `make test` en
entier, sans coupure.**

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J42.md`, une entrée par tâche, commitée avec elle.

Et une dernière chose : **complète ta passe de clôture d'hier** plutôt que d'en
écrire une nouvelle. Ce document est celui qu'on lira à la reprise ; il doit
rester à un seul endroit.

## Ce que j'attendrai demain matin

Une suite complète verte, sans coupure. Et un écran où quelqu'un qui arbitre un
litige sur une remise contestée trouve ce qui s'est passé.
```

---

## Après cette nuit

**Le développement du périmètre pilote est fini pour de bon.** Les nuits reprennent quand le
terrain aura parlé : la calibration (ETA, seuils, tarifs réels) a besoin des données du pilote.

Ce qui reste dépend entièrement de vous, et aucune de ces lignes n'attend une autre :

| Ce qui reste | Latence propre |
|---|---|
| **VPS + DNS** (apex, `api.`, `admin.`, `storage.`) | Des heures — la démonstration suit immédiatement |
| **Relais SMTP** | Vérification du domaine, plusieurs jours |
| **Compte Google Cloud** | Des heures |
| **Restauration sur un hôte vierge** | Une soirée — sans elle, L8-08 n'est pas finie |
| **Une demi-journée avec un téléphone** (L6-19) | Sans elle, aucun chauffeur ne s'inscrit |
| **Validation du plan comptable** | Votre comptable |

Et le chiffre à relever dès les premières courses : **combien échouent faute de pouvoir joindre le
passager** (D66).
