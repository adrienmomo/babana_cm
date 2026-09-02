# Prompt de lancement — session de nuit J32

**Objectif** : refermer la revue des habilitations, puis ouvrir le back-office superviseur.

**La branche `J31-securite` ne fusionne pas avant que ces trois corrections soient dedans.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: revue J31, D54 lectures au nom de l'utilisateur, D55 suspendre n'est pas aveugler"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-08.md`.

J'ai fait la revue de `J31-securite`, comme annoncé. Les règles sont justes et
le piège de `res.partner` — deux conditions indépendantes qui feraient
réapparaître un ancien client — a été vu et évité. Trois corrections avant
fusion.

## Périmètre de cette session

1. **D54** — les lectures des contrôleurs au nom de l'utilisateur
2. **D55** — une suspension empêche de travailler, pas de voir
3. **Le tableau L8-01 corrigé** — deux cellules demandaient l'impossible
4. **L9-01 à L9-03** — début du back-office superviseur

**Si le lot ne passe pas en entier, arrête-toi après les trois corrections.**

## D54 — deux gardes, dont une seule s'exécute

Tes règles d'enregistrement sont justes, et **elles ne s'exécutent jamais** : les
contrôleurs lisent tous en `sudo`. La protection réelle est le contrôle explicite
que L4-03 a écrit dans chaque contrôleur.

Rien ne fuit — les deux disent la même chose. Mais c'est la configuration que ce
dépôt a appris à redouter, D26 et D31 appliqués à la sécurité : le jour où un
contrôleur oublie son contrôle, la seconde ligne ne rattrape rien, parce qu'elle
n'est pas sur le chemin.

**Les lectures passent donc par l'utilisateur.** Les règles deviennent la
garantie ; le contrôle du contrôleur devient ce qu'il aurait dû être — la façon
de dire **pourquoi** c'est refusé, pas **si** ça l'est.

Les écritures gardent `sudo` : elles passent par les transitions, qui portent
leurs préconditions (invariant 2).

**Attention à ce que ça change dans les réponses.** Une course qu'on ne peut pas
voir devient introuvable plutôt qu'interdite — c'est souhaitable (on ne confirme
pas son existence), mais les codes d'erreur et les tests qui attendaient un refus
explicite doivent suivre. Ne fais pas l'inverse : ne rétablis pas un 403 pour
faire passer un test.

Et vérifie qu'aucune lecture légitime ne casse : un contrôleur qui cherche un
chauffeur par son identifiant public **avant** de savoir si l'appelant y a droit
a besoin de `sudo` pour cette recherche-là. Nomme ces cas plutôt que de les
généraliser.

## D55 — suspendre n'est pas aveugler

`state = approved` figure dans toutes les règles. Deux conséquences que personne
n'avait cherchées :

**Un chauffeur suspendu ne voit plus ce qu'il doit** — ni compte courant, ni
remises. Il doit de l'argent et n'a plus aucun moyen de savoir combien. C'est le
raisonnement de D29 retourné contre nous.

**Et il perd la course qu'il est en train de faire.** Son application cesse de
fonctionner au milieu d'un trajet, avec un passager. Un superviseur qui suspend
en urgence veut arrêter le prochain trajet, pas casser celui-ci.

La suspension agit là où elle doit : sur la disponibilité, où elle agit déjà. La
lecture reste.

## L9-01 à L9-03 — l'écran par lequel un chauffeur entre

Trois points.

**La validation d'un dossier suppose de voir les pièces.** Un gestionnaire qui
valide un permis sans pouvoir le regarder valide une case, pas un document —
c'est le doute que tu avais toi-même relevé en écrivant L6-15. L'aperçu passe par
l'accès signé à durée limitée de L1-05, jamais par une URL publique.

**Un refus porte son motif, et il voyage** jusqu'à l'écran du chauffeur — le
chemin existe depuis J27, il faut le remplir.

**Le suivi des courses est un outil de travail, pas un tableau de bord.** Ce
qu'un superviseur cherche : les courses en cours, celles qui ont mal fini, les
chauffeurs bloqués au plafond. Pas des moyennes.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport. La branche `J31-securite`
accueille les trois corrections ; **je la relirai une seconde fois avant
fusion**, c'est le seul lot où je préfère deux passes à une.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J32.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un chauffeur qui demande la course d'un autre et reçoit un vide — parce que la
base l'a filtré, pas parce qu'un contrôleur y a pensé. Et un chauffeur suspendu
qui voit toujours ce qu'il doit.
```

---

## Après cette nuit

Restera, en périmètre pilote : le back-office (L9-04, L9-05), le mode dégradé (L6-16), la file de
rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les sauvegardes (L8-08), les
scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone.

**La démonstration ne dépend plus que du VPS et du DNS** — et une fois les habilitations fusionnées,
l'accès pourra être ouvert au client.
