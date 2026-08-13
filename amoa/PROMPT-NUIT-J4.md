# Prompt de lancement — session de nuit J4

**Objectif** : fusionner la machine à états après correction, fermer le jalon J2, puis attaquer les endpoints du cycle de vie — le cœur de J3.

**Changement notable** : L4-02 a été relue. Elle devient fusionnable cette nuit, après un correctif précis. Trois tâches se débloquent derrière elle.

---

## À faire avant de lancer

Le dépôt contient des modifications non commitées — les arbitrages de ce matin et le correctif Hermes appliqué à la main. À enregistrer d'abord, sinon la session travaillera sur une base ambiguë :

```bash
git add -A
git commit -m "amoa: arbitrages du 13 août ; L0-03R: hermesCommand résolu via hermes-compiler"
```

Vérifier au passage que l'APK de l'app Chauffeur sort aussi — le correctif Hermes y est déjà, seule la commande n'a pas été lancée :

```bash
cd code/apps/driver/android && ./gradlew assembleRelease
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-13.md`, qui
contient les arbitrages sur les écarts que tu as relevés la nuit dernière.

## Ce qui a changé depuis ta dernière session

**La branche `L4-02-state-machine` a été relue par un humain.** Elle est jugée
solide — les huit transitions, le garde-fou sur `write()`, l'invalidation du
cache après verrou et le test d'invariant de partition sont validés tels quels.

Un seul défaut bloque la fusion, et il est décrit ci-dessous. Une fois corrigé,
**tu fusionnes la branche** : c'est la levée explicite de la consigne de la nuit
du 10 août.

## Périmètre de cette session

### Phase 1 — corrections, puis fusion

**L4-02R2 — le garde-fou manquant sur `create()`.**

`write()` interdit l'écriture directe de `state`, `create()` ne l'interdit pas.
`create({'state': 'settled', ...})` fait donc naître une course déjà encaissée
sans qu'aucune transition n'ait eu lieu — l'invariant 2 est vrai en modification
et faux en création. Et `settled` est l'état qui alimentera le compte courant
chauffeur et la facturation.

Toute création hors du chemin de transition force `state = 'requested'`, ou
échoue si un autre état est demandé. Même mécanisme de contexte que `write()`,
donc résistant à `sudo()`. Un test dédié, qui échoue aujourd'hui.

Documenter au passage deux points relevés à la relecture, sans changer le code :

- La vérification applicative qu'un chauffeur n'a pas déjà une course active
  **n'est pas une garantie** : elle verrouille la course, pas le chauffeur. Deux
  clients proposant le même chauffeur sur deux courses différentes passent tous
  deux le contrôle. La garantie réelle est l'index unique partiel. **L4-03 devra
  traduire la violation d'index en `DRIVER_ALREADY_TAKEN`.**
- L'`invalidate_recordset()` après le verrou mérite son commentaire : sans lui,
  une transaction ayant attendu relirait un état périmé depuis le cache.

**Puis fusionne `L4-02-state-machine` dans `master`.**

**L1-01R / L1-03R2 — l'enrôlement chauffeur.**

Un sign-in chauffeur ne doit plus créer de fiche `hr.employee`. En l'état,
n'importe quel compte Google appelant `/auth/google` avec `role=driver` fait
naître une fiche dans le module RH — porte ouverte, pollution, vecteur de spam.

Il crée désormais une **candidature** : un `babana.driver` à l'état `pending`,
sans rattachement salarié. `employee_id` devient facultatif tant que l'état vaut
`pending`, et obligatoire dès `approved`. C'est L1-06 qui créera ou rattachera la
fiche RH à la validation.

Conséquence assumée à ce stade : aucun chauffeur ne peut être approuvé tant que
L1-06 n'existe pas — ce qui est déjà le cas aujourd'hui. L1-06 est dans le lot.

Ajouter une limitation de débit sur la création de candidature.

**L2-01R / L4-01R2 — la référence de règle tarifaire.**

`babana.ride` porte une référence vers la règle appliquée, en plus du gel par
valeur. Les deux ne s'opposent pas : le gel rend la facture explicable pour
toujours, la référence dit **quelle** règle a servi.

L'immutabilité de `babana.fare.rule` se limite alors aux règles **réellement
utilisées**. Une règle jamais servie redevient librement modifiable — sans quoi
corriger une faute de frappe oblige à créer une version, friction quotidienne au
back-office pendant le pilote.

Conserver le garde-fou sur le **changement réel de valeur** : c'est ce qui
permet aux données initiales du module de se recharger.

### Phase 2 — fermer J2, puis ouvrir J3

Dans cet ordre :

1. **L1-05** — documents chauffeur, stockage et accès signés
2. **L1-06** — validation du dossier, création ou rattachement de la fiche RH
3. **L4-11** — test de concurrence, hors du harnais Odoo
4. **L4-10** — tests de la machine à états, générés depuis la table
5. **L4-03** — endpoints du cycle de vie

L1-05 et L1-06 ferment le jalon J2 et complètent l'arbitrage sur l'enrôlement.
L4-03 ouvre J3.

N'entreprends aucune tâche hors de cette liste.

## Protocole — inchangé

Lis les spécifications des tâches dépendantes de ton lot, même si elles ne sont
pas à faire. Pour L4-03, lis L4-04 à L4-07. Pour L1-05, lis L1-09.

Les fichiers d'écart vont sur `master`, toujours.

Les champs-pont sont tracés dans `code/docs/bridge-fields.md`, et **la tâche
cible commence par supprimer ceux qui la nomment** : L1-05 doit faire disparaître
`license_expires_on` et `license_alert_sent_on` de `babana.driver`, et reprendre
`_cron_alert_and_block_drivers` pour lire le document `license` le plus récent.

**Exécute la suite au moins une fois sur une base fraîche** avant de déclarer une
tâche finie. La nuit dernière a montré qu'une base accumulée ment.

## Points d'attention

**L4-11 est le rattrapage d'une erreur de spécification, pas un test de plus.**
Le mécanisme de verrouillage est correct ; c'est le harnais Odoo qui le rendait
intestable — `TransactionCase` annule la transaction en fin de test, une seconde
connexion ne voit rien ou attend un verrou. Le test vit dans `test/concurrency/`
et tourne contre une pile réelle. Le critère 5 est le seul qui compte vraiment :
une implémentation volontairement naïve doit faire échouer les trois scénarios.

**L1-05, les documents** : aucun objet n'est servi en URL publique, jamais. Accès
signé à durée limitée uniquement, et un chauffeur ne peut pas obtenir d'URL pour
le document d'un autre. Le test qui prouve quelque chose est celui qui tente
l'accès direct et échoue.

**L4-03 ne contient aucune règle métier.** Le contrôleur traduit HTTP en appel de
méthode, rien de plus. Une condition métier écrite là sera contournée par le
back-office, qui appelle la méthode directement.

**Les pièges de plateforme se documentent** dans `code/docs/odoo-pitfalls.md` —
notamment le vidage avant contrainte SQL, rencontré trois fois la nuit dernière.
S'il n'existe pas encore, le créer avec les quatre cas déjà connus.

## Rapport du matin

`amoa/rapport-nuit-J4.md`, tenu au fil de l'eau, même structure : état par tâche,
ce qui tourne, ce qui ne tourne pas avec les messages d'erreur exacts, questions
ouvertes, hypothèses prises, contradictions trouvées entre spécifications, champs
-pont créés et supprimés, ce que tu ferais ensuite.

## Ce que j'attendrai demain matin

La machine à états fusionnée, le jalon J2 fermé — un chauffeur s'inscrit, un
gestionnaire valide son dossier — et les endpoints du cycle de vie amorcés.

Comme les nuits précédentes : les questions et les contradictions m'intéressent
autant que le code.
```

---

## Après cette nuit

Si le lot passe en entier, il ne restera que L2-04, L2-05 et le lot L3 pour rendre une course démontrable de bout en bout côté serveur. Les écrans mobiles (L6) suivront.

Le compte Google Play, lui, n'attend que vous — et c'est le seul délai du projet que personne ne peut rattraper à votre place.
