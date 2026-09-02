# Prompt de lancement — session de nuit J33

**Objectif** : qu'une suspension agisse là où elle compte, puis ouvrir le back-office superviseur.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git checkout master
git merge --no-ff J31-securite -m "L8-01 + L8-02 : habilitations mobiles, revues et fusionnées"
git add -A
git commit -m "amoa: seconde revue J31, branche fusionnée, suspension à câbler"
```

La branche est relue et validée. Les trois corrections y sont, et le seul défaut que la seconde
passe a trouvé lui préexiste — il est le premier point de cette nuit.

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-09.md`.

La branche des habilitations est fusionnée. Ta seconde correction — retirer
`state = approved` partout, et pas seulement sur le compte courant — allait plus
loin que ma consigne et elle avait raison : un chauffeur rejeté doit lire sa
propre fiche pour savoir pourquoi il l'a été.

## Périmètre de cette session

1. **Le câblage suspension → temps réel**
2. **L9-01 à L9-03** — back-office superviseur : validation des dossiers, suivi
   des courses

## 1. Suspendre doit retirer du vivier

`action_suspend` passe `is_online` à faux côté Odoo et révoque les jetons. **Et
rien ne prévient le service temps réel** : le chauffeur reste dans le vivier
géo-indexé et continue de recevoir des propositions jusqu'à l'expiration de sa
position.

Le patron existe déjà — `notify_cash_limit_reached`, construit pour le
franchissement de plafond, avec ses trois règles : **au commit et jamais pendant**
(D32), **jamais depuis un savepoint** (D33), et il **notifie sans transitionner**
(D31). Applique-le, ne le réinvente pas.

Et regarde s'il y a un troisième cas : toute transition d'état d'un chauffeur qui
doit le rendre indisponible — rejet, suspension, réactivation — a besoin du même
câblage. La réactivation est le cas symétrique : elle ne doit **pas** le remettre
dans le vivier toute seule, c'est au chauffeur de se redéclarer en ligne.

## 2. L9-01 à L9-03 — l'écran par lequel un chauffeur entre

**Valider un dossier suppose de voir les pièces.** Un gestionnaire qui valide un
permis sans pouvoir le regarder valide une case, pas un document — c'est le doute
que tu avais relevé en écrivant L6-15. L'aperçu passe par l'accès signé à durée
limitée de L1-05, jamais par une URL publique. Et il passe désormais par une
lecture au nom de l'utilisateur (D54) : un gestionnaire a le droit, un client
non, et c'est la règle qui le dit.

**Un refus porte son motif, et il voyage** jusqu'à l'écran du chauffeur. Le
chemin existe depuis J27 et depuis ta correction d'hier — il ne reste qu'à le
remplir côté back-office.

**Le suivi des courses est un outil de travail, pas un tableau de bord.** Ce
qu'un superviseur cherche à neuf heures du matin : les courses en cours, celles
qui ont mal fini, les chauffeurs bloqués au plafond, les dossiers en attente. Pas
des moyennes — les indicateurs sont L9-07, et ils ont besoin de données que le
pilote produira.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J33.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un chauffeur suspendu qui disparaît du vivier dans la seconde, et un
gestionnaire qui peut regarder un permis avant de le valider.
```

---

## Après cette nuit

Restera, en périmètre pilote : le back-office (L9-04, L9-05), le mode dégradé (L6-16), la file de
rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les sauvegardes (L8-08), les
scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone.

**Les accès peuvent désormais être ouverts** : la démonstration ne dépend plus que du VPS et du
DNS.
