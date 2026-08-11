# Prompt de lancement — session de nuit J3

**Objectif** : appliquer les corrections arbitrées ce matin, débloquer le build Android, puis avancer sur la flotte et la tarification — tout ce qui ne dépend pas de L4-02, qui attend une relecture humaine.

---

## À faire avant de lancer

**1. Mettre à jour le `CLAUDE.md` racine** — il a changé ce matin (démarrage ajouté à l'invariant 1, champs-pont, fichiers d'écart sur `master`) :

```bash
cp amoa/CLAUDE.md CLAUDE.md
```

**2. Supprimer le doublon** une fois la copie faite. `amoa/CLAUDE.md` était le véhicule de livraison ; maintenant que le dépôt existe, il fait double emploi et va diverger :

```bash
git rm amoa/CLAUDE.md
```

**3. Récupérer le fichier d'écart resté sur la branche** :

```bash
git show L4-02-state-machine:amoa/questions/L4-02.md > amoa/questions/L4-02.md
git add -A && git commit -m "amoa: arbitrages du 11 août, écart L4-02 rapatrié sur master"
```

**4. Vérifier l'outillage Android**, puisque le correctif Gradle est au programme :

```bash
node -v && java -version 2>&1 | head -1 && echo $ANDROID_HOME
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier — il a changé ce matin : le démarrage rejoint les
événements qui écrivent (invariant 1), et deux conventions nouvelles
apparaissent, les champs-pont et les fichiers d'écart sur `master`.

Puis `amoa/questions/REPONSES-2026-08-11.md`, qui contient les arbitrages sur les
écarts que tu as relevés la nuit dernière.

## Contexte de départ, à connaître avant de commencer

`L4-02` est développée sur sa branche `L4-02-state-machine` et **attend une
relecture humaine**. Elle n'est pas fusionnée et ne le sera pas cette nuit. Le
lot ci-dessous est construit pour ne rien lui devoir : aucune tâche de cette nuit
ne dépend de la machine à états.

Ne fusionne pas cette branche, quoi qu'il arrive.

## Protocole — inchangé, deux rappels

**Lis les spécifications des tâches dépendantes de ton lot**, même si elles ne
sont pas à faire. Cette règle a produit deux contradictions utiles la nuit
dernière. Pour L2-03, lis L2-04 et L2-07 ; pour L1-07, lis L1-08 et L1-10.

**Les fichiers d'écart vont sur `master`**, même quand la tâche reste sur une
branche non fusionnée. La nuit dernière, `amoa/questions/L4-02.md` est resté
prisonnier de sa branche : le fichier d'écart de la tâche la plus importante
était invisible. C'est précisément quand une tâche demande une revue que sa
question doit être lisible.

## Périmètre de cette session

### Phase 1 — corrections (à faire en premier)

**L4-02R — sur la branche `L4-02-state-machine`, toujours sans fusionner.**

- Retirer `tests/test_ride_state_concurrency.py` : il part vers L4-11, hors du
  harnais Odoo. Le critère d'acceptation 4 de L4-02 renvoie désormais à L4-11.
  La cause de l'instabilité est connue : `TransactionCase` enveloppe le test dans
  une transaction annulée à la fin, une seconde connexion réelle ne voit rien ou
  attend un verrou. Le harnais était en cause, ni le test ni le mécanisme.
- `action_cancel` depuis `rejected` enregistre la catégorie
  `abandon_after_rejection` et le rang du refus au moment de l'annulation. Voir
  L4-07 corrigé. L9-09 en dépend : sans cette catégorie, l'indicateur d'abandon
  après refus devrait être reconstitué en croisant l'historique des refus.

**L4-01R — fusionnable, L4-01 est déjà sur `master`.**

L'index unique partiel côté **client** doit inclure `requested`. Les états actifs
diffèrent selon la partie : en `requested`, aucun chauffeur n'est désigné, l'état
ne le concerne pas ; mais pour le client, la course est bien en cours. Le
contrôle Python ajouté dans `action_request` devient redondant et disparaît.

**Champs-pont — nouvelle convention, à appliquer rétroactivement.**

- Créer `code/docs/bridge-fields.md` : un tableau champ, modèle, tâche qui doit
  le faire disparaître, date de création
- Y inscrire tous les champs transitoires existants, et leur ajouter la mention
  `[PONT — remplacé par <ID-TACHE>]` dans leur `help`
- **Vérifier que `babana_role` et `babana_driver_state`, posés sur `res.users`
  par L1-01, ont bien disparu avec L1-03.** S'ils survivent, les supprimer : le
  statut du chauffeur vient de `babana.driver`, pas d'une copie sur l'utilisateur

**L0-03R — correctif du build Android en monorepo.**

`./gradlew assembleRelease` échoue : `settings.gradle` cherche
`apps/client/node_modules/@react-native/gradle-plugin`, alors que les espaces de
travail npm remontent les dépendances à `code/node_modules/`. Le CLI React Native
génère une configuration qui suppose une application autonome.

Diagnostic d'abord :

    ls code/node_modules/@react-native/gradle-plugin
    grep -rn "node_modules" code/apps/*/android --include=*.gradle --include=*.properties

Correctif : remplacer les chemins relatifs par une résolution via Node, qui suit
le remontage. Dans `settings.gradle`, les deux `includeBuild` deviennent

    includeBuild(new File(["node", "--print",
      "require.resolve('@react-native/gradle-plugin/package.json')"]
      .execute(null, rootDir).text.trim()).getParentFile().absolutePath)

et dans `app/build.gradle`, le bloc `react { }` résout `reactNativeDir` et
`codegenDir` de la même façon. Vérifier qu'aucun dépôt de `android/build.gradle`
ne pointe encore sur `$rootDir/../node_modules/react-native/android`.

Même correction pour `apps/driver`. Le critère est le critère 4 de L0-03 : un APK
release produit pour chaque app. Si l'outillage Android manque encore, dis-le et
n'invente pas de contournement.

### Phase 2 — flotte et tarification

Dans cet ordre :

1. **L1-07** — modèle `babana.motorcycle` et gestion de flotte
2. **L1-08** — affectation durable moto ↔ chauffeur, avec historique
3. **L1-10** — alertes d'échéance d'assurance et de permis
4. **L2-01** — modèle `babana.fare.rule`
5. **L2-02** — zones géographiques
6. **L2-03** — moteur de cotation

N'entreprends aucune tâche hors de cette liste.

**L1-07 est le premier test de la convention des champs-pont** : elle doit faire
disparaître `motorcycle_id` de la liste, pas l'ajouter à côté d'un champ plat qui
survivrait.

## Points d'attention

**L2-03, le moteur de cotation, doit être une fonction pure.** Aucune lecture de
l'horloge ni de la base à l'intérieur du calcul. C'est ce qui permettra de
rejouer un litige tarifaire à l'identique dans six mois. Si le typage ou la
structure résiste, c'est probablement que quelque chose est passé en paramètre
qui aurait dû rester dehors, ou l'inverse.

**Les valeurs métier sont plausibles et marquées provisoires** (D21), jamais
aléatoires. Prix au kilomètre de l'ordre de ce qui se pratique à Douala, pas un
nombre tiré au hasard : une valeur plausible permet de repérer une anomalie de
calcul à l'œil. Elles vont **en base**, chargées par les données initiales du
module, jamais dans le `.env`.

**L2-02, les zones** : une seule zone couvrant Douala pour le pilote, avec la
grille tarifaire de repli. Le découpage fin viendra quand L9-07 montrera où sont
les heures de pointe réelles — le deviner d'avance serait de la fiction. Test
d'appartenance en Python, sans PostGIS : le volume de zones est faible et
PostGIS complique le déploiement pour un bénéfice nul à cette échelle.

**L1-07, l'assurance expirée** : une moto non assurée ne doit pas pouvoir être
affectée, et un chauffeur dont la moto n'est plus assurée ne doit pas pouvoir
passer en ligne. C'est un blocage, pas un avertissement — rouler sans assurance
est un risque juridique que le système doit rendre impossible.

## Rapport du matin

`amoa/rapport-nuit-J3.md`, tenu au fil de l'eau, même structure que la nuit
dernière — état par tâche, ce qui tourne, ce qui ne tourne pas avec les messages
d'erreur exacts, questions ouvertes, hypothèses prises, contradictions trouvées
entre spécifications, ce que tu ferais ensuite.

Ajoute une section **champs-pont** : ceux que tu as créés, ceux que tu as
supprimés, et l'état de `code/docs/bridge-fields.md` à l'arrivée.

## Ce que j'attendrai demain matin

Le build Android qui produit enfin un APK, la flotte et la tarification posées,
et L4-02 dans le même état qu'au départ — corrigée sur sa branche, non fusionnée.

Comme les nuits précédentes : les questions et les contradictions m'intéressent
autant que le code.
```

---

## Si vous relisez et fusionnez L4-02 avant de lancer

Trois tâches se débloquent et deviennent plus prioritaires que le lot L2. Dans ce cas, remplacer la phase 2 par :

```
1. L4-11 — test de concurrence, hors du harnais Odoo, contre une pile réelle
2. L4-10 — tests de la machine à états, générés depuis la table de transitions
3. L4-03 — endpoints du cycle de vie
4. L1-07, L1-08 — flotte, si le temps le permet
```

C'est le chemin le plus court vers J3, la course démontrable de bout en bout. Mais il suppose que vous ayez relu la machine à états — et cette relecture vaut mieux qu'une nuit gagnée.
