# Prompt de lancement — session de nuit J36

**Objectif** : refermer les deux derniers trous serveur.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J35, point 9 de la définition de fini, calendrier réécrit autour des démarches"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier — **il a un neuvième point à la définition de fini**,
ajouté hier soir grâce à ta revue visuelle. Puis
`amoa/questions/REPONSES-2026-09-12.md`.

Cinq écrans cassés sur six, toutes les suites vertes, et un lot que j'avais relu
moi-même. Ta revue est la nuit la plus utile depuis le début du projet.

## Périmètre de cette session

1. **L3-12** — file persistante avec rejeu, côté service temps réel
2. **L4-06** — facture

## L3-12 — le dernier chemin sans filet

C'est le trou signalé depuis le 20 août : un refus dont l'appel Odoo échoue
durablement laisse la course en `proposed` **pour toujours**, et
`action_propose` n'accepte que `requested`/`rejected` en source — donc plus
aucune proposition possible sur cette course. Le client reste devant un écran qui
n'avancera jamais.

Trois points.

**La file est persistante, donc elle survit à un redémarrage du service.** C'est
tout l'objet : un service qui tombe entre une acceptation et son écriture Odoo
ne doit pas perdre l'événement. L3-14 le testera en le tuant en pleine course.

**Le rejeu est idempotent côté Odoo**, et le mécanisme existe depuis L4-03 —
appuie-toi dessus. Rejouer une transition déjà appliquée doit être sans effet,
pas une erreur.

**Une entrée qui échoue indéfiniment se voit.** Une file qui accumule en silence
est pire qu'un échec immédiat : personne ne saura qu'une course est bloquée. Un
compteur, un âge de la plus ancienne entrée, et une trace — le même principe que
la réconciliation d'engagement, qui répare **et** dénonce.

Et ne confonds pas cette file avec celle de `packages/api-client` : celle-ci est
côté service, pour les appels sortants vers Odoo.

## L4-06 — la facture

Une course encaissée sans facture est un problème comptable dès le premier jour
de pilote.

**`account.move` natif** (§6 de l'architecture) : la numérotation légale, le PDF
et l'envoi par email viennent avec. N'écris pas un modèle de facture.

**Elle rejoint le même point d'accroche que le reste** : au commit (D32), jamais
depuis un savepoint (D33). L'encaissement porte déjà un savepoint et c'est
exactement là que L4-05 t'attendait — son commentaire nomme cette tâche.

**Et le montant facturé est celui de la course**, gelé. Pas un recalcul : c'est
tout l'objet du gel par valeur de L2-04, et une facture qui recalculerait
pourrait différer de ce que le client a payé.

Attention à la devise : elle est exigée à l'installation depuis D53, donc la
facture est en francs CFA par construction. Vérifie-le sur une facture réelle
plutôt que sur le paramètre.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

**Et le point 9** : L4-06 produit une facture qu'un superviseur regardera. Ouvre
l'écran, regarde le PDF, et dis ce que tu vois. Le jeu de données doit porter de
quoi le remplir.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J36.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Une course dont l'écriture vers Odoo a échoué et qui repart toute seule après un
redémarrage du service. Et une facture en francs CFA qu'un client pourrait
recevoir.
```

---

## Après cette nuit

Restera, en périmètre pilote : les sauvegardes (L8-08), les scénarios de bout en bout (L10-01), et
l'OTP (L1-09, suspendu à la passerelle SMS).

**Trois tâches, dont une qui n'attend que vous.**

Et deux démarches dont le calendrier dépend maintenant entièrement :

- **La passerelle SMS** — seule sur le chemin critique. Lancée cette semaine, la date tient ;
  lancée dans trois semaines, elle glisse d'autant.
- **Une demi-journée avec un téléphone (L6-19)** — sans le sélecteur de pièces, aucun chauffeur
  réel ne peut s'inscrire.

Le détail est dans `amoa/06-jalons-et-pilote.md`, réécrit autour de ces démarches plutôt qu'autour
des nuits.
