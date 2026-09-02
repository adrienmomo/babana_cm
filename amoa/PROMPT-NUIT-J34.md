# Prompt de lancement — session de nuit J34

**Objectif** : fermer la boucle de la caisse, de ce que le superviseur saisit à ce que le chauffeur
voit.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J33, D56 ratifiée, zone d'activité retirée, tracé ouvert plutôt qu'affiché"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-10.md`.

D56 est ratifiée, et l'asymétrie que tu soumettais est justifiée — le §1 dit
pourquoi, et c'est une distinction qui te servira ailleurs.

Une correction à ton rapport, sur un point qui compte : la révocation des jetons
n'est **pas** un filet contre un chauffeur suspendu resté visible. Elle force une
reconnexion, elle ne l'interdit pas — c'est le contrôle d'éligibilité côté Odoo
qui l'empêche de repasser en ligne. Quelqu'un qui croirait la révocation
suffisante pourrait retirer ce contrôle un jour.

## Périmètre de cette session

1. **L9-04** — zones et grilles tarifaires au back-office
2. **L9-05** — remises de caisse à valider
3. **L5-07** — écran de recette côté chauffeur

Les trois ferment la même boucle. Prends-les dans cet ordre : le superviseur
saisit, valide, et le chauffeur voit.

## L9-04 — la grille tarifaire est ce qu'on ajustera le plus au pilote

C'est l'écran par lequel un tarif change. Trois points.

**Une modification de grille ne change jamais le prix d'une course déjà
estimée.** L2-04 gèle la règle appliquée par valeur, précisément pour ça — c'est
ce qui rend le tarif opposable. Le back-office ne doit offrir aucun geste qui
contredise ce gel.

**Un coefficient d'heure de pointe se règle en connaissant l'heure locale.** Le
fuseau est posé depuis D45 ; vérifie que ce que le superviseur voit et ce que le
moteur applique parlent de la même heure.

**Une zone est un polygone**, et les polygones se recouvrent ou laissent des
trous. Un point qui n'appartient à aucune zone doit avoir un comportement défini,
et le superviseur doit pouvoir le constater sans lire le code.

## L9-05 — la validation d'une remise touche à l'argent

Elle est sous les mêmes règles que le lot L5, et je la relirai.

**Le superviseur valide ce qui est réellement remis** (D29), et l'écart reste au
solde du chauffeur. Le formulaire ne doit pas laisser croire qu'il faut faire
correspondre les deux montants pour valider.

**L'écriture comptable part au commit** (D32), jamais depuis un savepoint (D33).
Le patron existe.

**Et l'écart se voit** : un superviseur qui valide une remise partielle doit
comprendre, à l'écran, que le chauffeur reste débiteur — pas le découvrir en
consultant le compte courant ensuite.

## L5-07 — le libellé n'est pas un détail

**« Recette encaissée », jamais « revenus »** (É6). Un chauffeur salarié ne voit
pas ses gains, il voit ce qu'il détient pour le compte de l'entreprise. Le mot
change ce qu'il comprend de sa situation, et c'est un écart assumé avec le
cahier des charges depuis le premier jour.

L'écran montre : encaissé du jour, solde dû, marge avant plafond. **La marge est
le chiffre qui compte** — c'est elle qui dit au chauffeur combien de courses il
peut encore faire avant d'être bloqué, et c'est ce qu'il regardera.

L'endpoint existe depuis J12 (`GET /drivers/me/cash`), la route de remise est
réservée depuis J26. Tu as posé les deux ; c'est le moment de les remplir.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Lis les spécifications des tâches dépendantes : pour L9-05, lis L5-04 et L5-06 ;
pour L5-07, lis L6-11 (le chemin qui y mène quand le plafond est atteint).

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J34.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un superviseur qui valide une remise partielle en voyant que le chauffeur reste
débiteur, et un chauffeur qui voit combien de courses il peut encore faire.
```

---

## Après cette nuit

Restera, en périmètre pilote : le mode dégradé (L6-16), la file de rejeu (L3-12), la facture
(L4-06), les sauvegardes (L8-08), les scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu
à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone.

Six tâches, dont une seule dépend de vous. **Premières courses visées au 13 octobre** —
`amoa/06-jalons-et-pilote.md`.
