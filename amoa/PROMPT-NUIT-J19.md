> **Note de la maîtrise d'ouvrage.** Ce prompt clôt un cycle : après lui, le parcours Client est
> complet et vérifiable de bout en bout, et les trois manques de découpage sont refermés. La suite
> naturelle est le lot Chauffeur.

# Prompt de lancement — session de nuit J19

**Objectif** : qu'une course puisse se terminer, trouver les trous qui restent, et unifier l'état
avant qu'il ne se disperse davantage.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J18, L3-19 émetteur de fin de course, D42 numéros de téléphone"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-27.md`.

Tu as trouvé hier qu'aucune course ne peut se terminer aux yeux du client.
C'est un manque de mon découpage, le troisième du même genre — et cette nuit
répare les trois à la fois : celui-là, et le moyen de trouver les suivants.

## Périmètre de cette session

1. **L3-19** — l'émetteur du cycle de vie vers le client (tâche nouvelle,
   `amoa/specs/L3-temps-reel.md`)
2. **C-02R** — la cartographie des messages du contrat (critère 5, nouveau)
3. **L3-18** — l'état de course unifié côté Redis

**Si le lot ne passe pas en entier, arrête-toi avant L3-18** et dis-le. Elle
touche la réservation atomique ; je la relirai moi-même, comme L3-06.

## L3-19 — trois règles qu'il serait facile de manquer

Cette tâche ressemble à du câblage anodin. Elle ne l'est pas.

**Au commit, jamais pendant** (D32). Une transition annulée ou rejouée ne doit
pas avoir déjà annoncé au client que sa course était terminée.

**Jamais depuis l'intérieur d'un savepoint** (D33). `action_complete` en porte
un : l'intention se retient, elle s'enregistre à la sortie réussie du bloc.

**Cet émetteur notifie, il ne transitionne rien** (D31). Pas de second chemin
d'écriture.

Et pose-le pour **deux abonnés**, pas un : l'application Chauffeur en aura
besoin symétriquement pour ses propres écrans. C'est le même message poussé à
deux destinataires, pas deux mécanismes.

`ride.completed` porte le détail décomposé (D41).

## C-02R — la cartographie, et pourquoi elle compte plus que sa taille

Trois manques de mon découpage, tous au même endroit : la navigation entre les
écrans, la synchronisation entre trois structures Redis, l'émission de la fin de
course. Aucun ne portait sur un composant. Tous portaient sur **ce qui relie les
composants**.

J'ai vérifié cent dix-huit fois qu'une tâche avait sa spécification, et jamais
qu'un message avait un émetteur.

La cartographie se dérive du contrat lui-même et échoue si un message n'a ni
émetteur, ni consommateur, ni mention explicite de la tâche qui le posera —
comme la machine à états et la matrice d'habilitations le font déjà depuis leur
fichier de données.

**Ce que je veux savoir, en plus du code : combien de messages sont dans ce
cas.** Dis-le dans le rapport, avec la liste. C'est la mesure de ce qui reste à
relier, et je n'en ai aucune idée aujourd'hui.

## L3-18 — deux exigences, et une qui prime

**Unifier la structure ne doit pas unifier les échéances.** Une réservation
expire vite, un engagement n'expire jamais tout seul, une session de suivi vit
le temps d'une course. C'est la distinction posée par D26, et une refonte
maladroite la réintroduirait sous une forme plus difficile à voir.

**Le test de concurrence de L3-13 passe sans qu'on touche à ses assertions.
S'il faut l'assouplir, la refonte est fausse** — c'est lui qui dit si
l'atomicité a survécu, et c'est pour ce moment précis qu'il a été écrit.

Le script d'éligibilité lit aujourd'hui quatre clés ; il ne devrait plus en lire
qu'un état. C'est le gain le plus concret et la meilleure façon de vérifier que
l'unification est réelle.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

**Et la vérification navigateur, sur le parcours entier, cette fois jusqu'au
résumé de fin** — c'est le critère 5 de L3-19, et c'est la quatrième nuit
consécutive où cette vérification trouve ce qu'aucune suite ne voit.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J19.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Une course commandée, suivie, terminée, et son résumé lu — dans un navigateur,
sans un seul contournement. Et la liste des messages du contrat qui n'ont
encore personne au bout.
```

---

## Après cette nuit

Le parcours Client sera complet et vérifiable de bout en bout, hors historique et factures.

Restera le **lot Chauffeur** : moins d'écrans, plus exigeants, puisqu'on les regarde en conduisant.
L3-19 lui aura déjà posé la moitié de ce dont il a besoin.

Puis **L8-03 et L8-04** — partage de trajet et bouton d'urgence, entrés sur le chemin critique sans
que mon découpage l'ait prévu, et les seules fonctions du produit qui touchent à la sécurité des
personnes.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et toujours, à délai subi : **la validation du plan comptable** — trois questions dont la TVA — et
**la vérification développeur Android**.
