# Prompt de lancement — session de nuit J11

**Objectif** : fermer l'histoire de la caisse.

**Cinq tâches, toutes financières, toutes sous revue humaine.** C'est le lot le plus sensible du
projet.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J10, D33 pas d'accroche au commit dans un savepoint"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-19.md`.

Son §2 décrit un défaut que j'ai trouvé en relisant ton encaissement, et son §3
une prudence à ajouter. Les deux se corrigent avant d'ouvrir la suite.

## Périmètre de cette session

**Corrections d'abord (courtes).**

1. **D33** — l'appel sortant du contrôle de plafond s'enregistre **après** la
   sortie réussie du savepoint, pas dedans. Plus l'entrée dans
   `code/docs/odoo-pitfalls.md` : le point d'accroche au commit ignore les
   savepoints, et ce dépôt commite des transactions dont un savepoint a été
   annulé. Ce piège est de la même nature que les trois qui y figurent déjà.
2. **Comparaison des montants** — la comparaison monétaire d'Odoo, à la
   précision de la devise, jamais une égalité de flottants.

**Puis le lot, dans cet ordre.**

3. **L5-03** — modèle `babana.cash.remittance`
4. **L5-04** — validation par un superviseur, remise à zéro du solde
5. **L5-05** — écriture comptable Odoo à la validation
6. **L5-06** — traitement des écarts
7. **L5-07** — écran de recette dans l'app Chauffeur

**Si le lot ne passe pas en entier, arrête-toi proprement** après L5-06 —
l'écran peut attendre, l'écriture comptable et les écarts forment un tout.

## Ce que D29 attend de L5-06

Le compte courant *permet* aujourd'hui qu'un écart reste au solde. Rien ne le
*produit*. C'est L5-06 qui rend D29 réel, et c'est le cœur de cette nuit.

**La règle, arbitrée le 18 août** (`01-architecture.md` §7) : le superviseur
valide ce qui est **réellement remis**, la différence demeure au compte courant
du chauffeur et **continue de peser sur son plafond**.

Trois conséquences à ne pas perdre :

- Le logiciel enregistre un fait — il manque tel montant. Il ne prend aucune
  décision de ressources humaines. Sur des chauffeurs salariés, c'est la seule
  position tenable.
- L'écart pèse là où le chauffeur le sent, sur sa capacité à travailler. Un
  écart sorti du compte courant serait un écart que plus personne ne regarde.
- Refuser la remise tant que le compte n'y est pas produirait l'effet inverse
  de celui recherché : un chauffeur bloqué au plafond pour 500 FCFA manquants
  ne peut plus travailler, donc plus rembourser.

« La remise remet le solde à zéro » (D8, point 4) n'est vrai que pour une
remise **complète**. Tu l'avais déjà relevé en écrivant L5-01 — c'est ici que
ça se concrétise.

## Points d'attention

**L5-05, l'écriture comptable.** C'est la tâche où une erreur ne se voit pas
avant un audit. Réutilise `account.move` d'Odoo plutôt qu'un modèle maison
(`01-architecture.md` §6) : la numérotation légale, le PDF et l'envoi par email
sont alors acquis. Si le plan comptable de la base de démonstration ne permet
pas de poser une écriture plausible, dis-le plutôt que d'inventer des comptes.

**L5-06, la détection de série.** Un écart isolé est banal ; une série d'écarts
dans le même sens chez le même chauffeur ne l'est pas. C'est le seul mécanisme
qui détectera un détournement progressif, et c'est le critère 5 de la tâche.
Le seuil est configurable, jamais en dur.

**L5-07, le libellé.** « Recette encaissée », jamais « revenus » (É6). Un
chauffeur salarié ne voit pas ses gains, il voit ce qu'il détient pour le compte
de l'entreprise. Le mot change tout, et il changera la façon dont un chauffeur
comprend son écran.

**Un commit par tâche.** J10 a groupé trois tâches financières dans un seul —
la discipline avait tenu six nuits. Sur ce lot-ci, qui touche à l'écriture
comptable, la relecture par tâche compte plus qu'ailleurs.

## L'avertissement, qui vaut double cette nuit

Partout ailleurs, un test vert prouve que le comportement correspond à la
spécification. Ici, il prouve seulement qu'il correspond aux chiffres que j'ai
écrits — et je me suis trompé plusieurs fois cette semaine, dont une fois sur un
critère de concurrence que tu as implémenté fidèlement.

Si une règle financière te paraît étrange, **arrête-toi et écris-le**. C'est le
lot où le protocole d'écart compte le plus, et le seul où une erreur silencieuse
se découvre chez le comptable plutôt qu'en test.

## Protocole — inchangé

`make reset` complet avant de déclarer quoi que ce soit fini : cette session
touche Odoo lourdement, et l'écriture comptable dépend de données initiales qui
ne se rechargent jamais sur une base accumulée.

Lis les spécifications des tâches dépendantes : pour L5-04, lis L5-05 et L5-06 ;
pour L5-07, lis L6-02.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J11.md`, une entrée par tâche, commitée avec elle.

## Ce que j'attendrai demain matin

Un chauffeur qui remet 40 000 sur 45 000 dus, une remise validée, une écriture
comptable posée, et 5 000 qui restent à son solde et pèsent sur son plafond.
```

---

## Après cette nuit

Le lot L5 sera fermé, et avec lui le morceau le plus sensible du projet.

Resteront côté serveur : L3-12 (la file de rejeu, dernier chemin sans filet), la seconde moitié du
lot temps réel, et L4-06 (la facture).

**Et surtout le lot L6 — les deux applications mobiles, qui n'ont pas commencé.** Tout ce qui a été
construit en dix nuits est invisible tant qu'il n'y a pas d'écran. Ce sera le sujet de la semaine
prochaine, et il faudra d'abord trancher la question des maquettes (D20 accepte le générique pour le
pilote, ce qui reste à confirmer maintenant que le produit devient réel).

Et la **vérification développeur Android** — la démarche à lancer, plutôt que le compte Play.
