# Prompt de lancement — session de nuit J31

**Objectif** : que les montants soient en francs CFA, et qu'un chauffeur ne puisse pas lire les
courses d'un autre.

**Les habilitations sont sous revue humaine.** Je les relirai moi-même, comme L3-06.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J30, D53 devise exigée et sans données de démonstration"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-07.md`.

Son §3 revient sur quelque chose que J29 avait classé « cosmétique » et qui ne
l'est pas. C'est la première tâche de cette nuit.

## Périmètre de cette session

1. **D53** — la devise, et les données de démonstration d'Odoo
2. **L8-01** — règles d'enregistrement Odoo
3. **L8-02** — matrice d'habilitations

## D53 — ce que « cosmétique » cachait

Le mouvement de compte courant prend par défaut la devise de la société. L'écriture
comptable aussi. La société est en dollars. Donc **le compte courant des
chauffeurs et le grand livre sont libellés en dollars**, pendant que l'API
annonce « XAF » en dur.

Deux bouts à traiter.

**Les données de démonstration d'Odoo ne s'installent plus.** Elles créent des
écritures dès l'installation, ce qui empêche ensuite de changer la devise — et
elles n'ont rien à faire dans cette base : un superviseur y verrait des clients
et des factures fictifs.

**La devise est exigée à l'installation**, vérifiée mécaniquement, comme les
contraintes d'hier. Le `"currency": "XAF"` écrit en dur dans le contrôleur
devient alors honnête par construction ; sans cette exigence, c'est une
affirmation que rien ne garantit — la même famille que la notification qui
disait « suivi actif ».

Vérifie ce que le retrait des données de démonstration casse : des tests, des
fixtures, le plan comptable. Si quelque chose en dépendait, c'est une
information utile en soi.

## L8-01 et L8-02 — le lot que je relirai ligne à ligne

`CLAUDE.md` les place sous validation humaine, et la raison est écrite : **une
matrice fausse produit des tests verts qui valident les mauvaises règles.** C'est
le seul lot où la suite ne peut pas se contrôler elle-même, parce qu'elle est
dérivée de la matrice qu'elle vérifie.

**La matrice se génère depuis un fichier de données**, et les tests avec elle.
Conséquence voulue : ajouter un modèle sans l'ajouter au fichier fait échouer la
suite. C'est un filet contre l'oubli, pas seulement contre l'erreur — et sur ce
lot-là, l'oubli est le mode de défaillance principal.

Trois propriétés à tenir, et à tester chacune par la négative — c'est ce qui
manque le plus souvent :

**Un chauffeur ne lit que ses courses.** Le test qui compte n'est pas « il voit
les siennes », c'est « il ne voit pas celles d'un autre ». Écris les deux.

**Un client ne lit aucun document de chauffeur.** Permis, pièce d'identité :
ce sont les données les plus sensibles du produit, et le seul chemin légitime
est l'accès signé à durée limitée de L1-05.

**Personne ne lit le compte courant d'un autre.** Ni un chauffeur celui d'un
collègue, ni un client quoi que ce soit.

Et une quatrième que je te demande d'ajouter : **un compte suspendu ou rejeté
perd ses accès immédiatement**, pas à l'expiration de son jeton. Le cas existe —
`driverStatus` porte déjà ces états — et c'est celui où une matrice statique se
fait prendre.

**Ne fais pas confiance aux droits d'accès seuls.** Les règles d'enregistrement
(`ir.rule`) sont ce qui filtre les lignes ; les droits d'accès ne filtrent que
les modèles. Un chauffeur avec le droit de lire `babana.ride` et sans règle
d'enregistrement les lit toutes.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale — et vérifie que les montants
s'affichent bien en francs CFA au back-office après le correctif.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J31.md`, une entrée par tâche, commitée avec elle.

Et une question précise, en plus de la tienne : **quelle est la règle que ta
matrice a le plus de mal à exprimer ?** C'est là que je regarderai en premier.

## Ce que j'attendrai demain matin

Un compte courant en francs CFA, et un chauffeur qui reçoit une liste vide
quand il demande les courses d'un autre.
```

---

## Après cette nuit

L'accès pourra être ouvert — au client pour la démonstration, puis aux chauffeurs au pilote.

Restera, en périmètre pilote : le back-office superviseur (L9-01 à L9-05), le mode dégradé
(L6-16), la file de rejeu (L3-12), la facture (L4-06), l'écran de recette (L5-07), les sauvegardes
(L8-08), les scénarios de bout en bout (L10-01) et l'OTP (L1-09, suspendu à la passerelle SMS).

Plus **L6-19**, la passe avec un téléphone.

**La démonstration, elle, ne dépend plus que du VPS et du DNS.**
