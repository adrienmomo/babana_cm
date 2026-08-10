# Prompt de lancement — session de nuit J2

**Objectif** : corriger les écarts arbitrés ce matin, puis avancer sur le chemin critique jusqu'à la machine à états.

**Préparation** : depuis `babana.cm/`, s'assurer que `CLAUDE.md` à la racine est à jour (il a changé ce matin — invariant 1 reformulé, deux cibles Makefile ajoutées).

```bash
cp amoa/CLAUDE.md CLAUDE.md
git add -A && git commit -m "amoa: arbitrages du 10 août, invariant de partition reformulé"
```

Mêmes vérifications que la nuit précédente : Docker actif, machine qui ne s'endort pas, lancement depuis `babana.cm/`.

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier — **il a changé ce matin**, l'invariant 1 est reformulé.
Puis `amoa/questions/REPONSES-2026-08-10.md`, qui contient les arbitrages sur les
écarts que tu as relevés la nuit dernière. Puis `amoa/03-decoupage-taches.md` §5.

## Deux changements de protocole par rapport à la nuit dernière

**1. Lis aussi les spécifications des tâches dépendantes de ton lot**, même si
elles ne sont pas à faire. La nuit dernière, C-03 a déclaré `in_progress →
cancelled` interdite alors que L4-07 l'autorise — la contradiction est passée
inaperçue parce que L4-07 était hors du lot. Avant L4-01 et L4-02, lis L4-03 à
L4-07 et L8-09. Si tu trouves une contradiction du même genre, c'est exactement
ce qu'il faut signaler.

**2. Certaines tâches se développent mais ne se fusionnent pas.** Elles sont
marquées ci-dessous. Développe sur la branche, vérifie tous les critères,
commite, mais **ne fusionne pas dans `main`** — je relirai demain. Développer
sans surveillance et fusionner sans revue sont deux choses différentes.

## Périmètre de cette session

### Phase 1 — corrections (à faire en premier, sans exception)

**C-03R — reprise de la machine à états.** Trois corrections dans
`code/docs/contracts/ride-state-machine.md` et son script de vérification :

- Supprimer la distinction `partition_moment` / `closure`. L'invariant a été
  reformulé : il n'y a plus de compte d'écritures, seulement des événements
  métier. Toutes les écritures sont des écritures d'événement. Le script ne doit
  plus vérifier « exactement quatre » mais **qu'aucune écriture n'est déclenchée
  par le temps écoulé, la distance parcourue ou l'expiration d'un compte à
  rebours sans effet métier**.
- Ajouter la transition `in_progress → cancelled`, **acteur chauffeur
  uniquement**, motif obligatoire, effet incluant un signalement au back-office.
  Elle reste interdite au client. Voir L4-07 et la spécification C-03 corrigée.
- Retirer `in_progress → cancelled` de la liste des transitions interdites, et y
  ajouter `in_progress → cancelled` **par le client**.

Vérifier au passage que `draft` n'est décrit nulle part comme persistable.

**L0-01R — compose et SMTP.** `mailpit` quitte `infra/compose.yaml` pour
`infra/compose.dev.yaml`. Dans `compose.yaml`, `SMTP_HOST` et `SMTP_PORT`
deviennent des variables d'environnement, et `SMTP_USER` / `SMTP_PASSWORD` sont
ajoutées. Les variables `SMTP_PROD_*` documentées par anticipation dans
`infra/env/README.md` disparaissent : ce sont les mêmes variables avec des
valeurs différentes selon l'environnement. La pile de base passe à six services.

Vérifier que `make up` produit toujours une pile saine et que `make verify`
passe.

### Phase 2 — chemin critique

Dans cet ordre :

1. **L1-01** — contrôleur d'authentification Google (le service simulé est prêt
   et vérifié depuis hier ; les tests négatifs sont maintenant écrivables)
2. **L1-02** — jetons applicatifs
3. **L1-03** — modèle `babana.driver`
4. **L1-04** — modèle client sur `res.partner`
5. **L4-01** — modèle `babana.ride`
6. **L4-02** — machine à états — **développer, ne pas fusionner**

N'entreprends aucune tâche hors de cette liste. En particulier **pas L4-03** :
les endpoints construits sur une machine à états non encore relue cumuleraient
le risque.

## Un test qui compte plus que les autres

L4-02 doit livrer un test qui prouve l'invariant reformulé :

> Deux courses comportant le même nombre de décisions humaines, mais de durées
> et de distances très différentes, produisent exactement le même nombre
> d'écritures Odoo.

C'est ce test qui protège la règle de partition, pas sa présence dans un
document. Si tu ne vois pas comment l'écrire proprement à ce stade, dis-le
plutôt que d'écrire un test décoratif.

## Méthode, tâche par tâche

Inchangée : lire la spécification complète, brancher depuis `main`, implémenter
dans `code/`, tester chaque critère, vérifier les sept points de la définition de
fini, commiter avec l'identifiant en préfixe, fusionner **sauf mention
contraire**, consigner dans `amoa/rapport-nuit-J2.md` avant de passer à la
suivante.

## Règle d'écart

Inchangée. Personne ne répondra cette nuit :

- Ambiguïté ou contradiction : écrire dans `amoa/questions/<ID-TACHE>.md`, poser
  une hypothèse explicite si elle permet d'avancer, sinon abandonner la tâche et
  passer à la suivante qui n'en dépend pas
- Ne jamais corriger une spécification de toi-même
- Ne jamais violer un invariant : écrire la question, passer à la suite
- Test rouge incompris : le laisser rouge, le documenter, ne pas le désactiver
  ni modifier l'attendu
- Ne jamais demander de confirmation sur un choix d'implémentation non spécifié

## Points d'attention connus

**L4-02 est la tâche la plus structurante du projet.** Surcharger `write` pour
interdire l'écriture directe de `state` casse facilement les mécanismes internes
d'Odoo, qui écrit lui-même des champs lors des calculs et des chargements de
données. Cibler `state` et les champs figés, laisser passer le contexte d'appel
des transitions. Un blocage trop large rend le module ininstallable.

**L1-01, la vulnérabilité classique** : ne jamais décoder un jeton sans vérifier
sa signature, même « juste pour lire le sub ». Le test qui vérifie qu'un `aud`
hors liste blanche est rejeté est obligatoire — le service simulé sait produire
ce jeton.

**L1-03** : `cash_balance` ne s'écrit jamais directement, il se calcule depuis le
journal des mouvements. Et le modèle ne doit pas rendre coûteux l'ajout ultérieur
d'un solde de commission (É3) — c'est un point de revue explicite.

**L0-05 reste hors lot** : elle construit un APK à chaque commit et le SDK
Android n'est pas installé. Ne pas la commencer.

**Données de démonstration** : conservées en développement, mais aucun test que
tu écris ne doit en dépendre. Elles n'existeront pas en recette.

## Rapport du matin

`amoa/rapport-nuit-J2.md`, tenu au fil de l'eau, même structure que la nuit
dernière : état par tâche, ce qui tourne, ce qui ne tourne pas avec les messages
d'erreur exacts, questions ouvertes, hypothèses prises, ce que tu ferais ensuite.

Ajoute une section supplémentaire : **contradictions trouvées entre
spécifications**, y compris celles que tu as détectées en lisant les tâches
dépendantes sans les implémenter. C'est le rendement attendu du premier
changement de protocole.

## Ce que j'attendrai demain matin

Les corrections faites et vérifiées, l'authentification qui fonctionne contre le
service simulé, et le domaine posé. L4-02 sur sa branche, prête à relire.

Comme la nuit dernière : les questions et les contradictions m'intéressent autant
que le code.
```

---

## Si vous installez l'outillage aujourd'hui

Node ≥ 22.11 et le SDK Android en ligne de commande débloquent deux tâches. Dans ce cas, ajouter à la fin de la phase 2 :

```
7. **L0-03R** — clore L0-03 : vérifier le critère 4 (APK release pour chaque app)
8. **L0-05** — intégration continue, build Android compris
9. **L0-09** — harnais de non-régression
```

Ces trois-là referment le jalon J1 pour de bon. Sans l'outillage, elles restent bloquées quelle que soit la qualité du reste.
