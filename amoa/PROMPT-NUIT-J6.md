# Prompt de lancement — session de nuit J6

**Objectif** : réparer l'accord sur le jeton d'accès, puis ouvrir le suivi temps réel.

**Quatre entrées.** La première est une correction, pas une tâche neuve : elle touche trois
services et son test traverse les deux. Compter comme une tâche M à part entière.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J5, D23 jeton contractuel, D24 repli sur cache périmé"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier. Une règle nouvelle y figure depuis ce matin, et elle
vient directement de la nuit dernière : une dépendance supposée absente se
vérifie dans le dépôt, jamais dans le prompt.

Puis lis `amoa/questions/REPONSES-2026-08-15.md` en entier avant toute chose.
Il arbitre les écarts de la nuit dernière et décrit un défaut bloquant que ta
première tâche doit réparer.

## Ce qui s'est passé la nuit dernière

Le service temps réel refuse tous les jetons d'accès réels. Odoo émet `uid`,
`ws/token.ts` exige `sub` et rejette ce qui n'en porte pas. Les deux suites sont
vertes parce que chaque côté fabrique ses propres jetons pour se tester. Aucune
connexion WebSocket réelle n'aurait jamais été acceptée en production.

Ce n'est pas une étourderie isolée. C'est ce qui arrive quand un format de fil
est déclaré deux fois. Garde ça en tête pour tout le lot L3 : le service temps
réel et Odoo ne se parlent presque jamais, et chaque fois qu'ils partagent une
valeur sans la partager depuis `@babana/contracts`, la même erreur redevient
possible.

## Périmètre de cette session

Quatre entrées, dans cet ordre.

1. **J6-C — corrections** (voir détail ci-dessous). Une seule branche, un commit
   par correction.
2. **L3-02** — ingestion des positions chauffeur : réception, validation de
   plausibilité, écriture Redis avec TTL
3. **L3-03** — géo-index des chauffeurs disponibles, requête des N plus proches
4. **L3-04** — bascule en ligne / hors ligne, entrée et sortie du pool

N'entreprends rien hors de cette liste. En particulier **pas L3-05 ni L3-06** :
la réservation atomique est la tâche la plus risquée du projet et elle demande
une revue humaine avant d'exister. Ne la commence pas parce que le reste s'est
bien passé.

## J6-C — le détail des corrections

**C1. La charge utile du jeton devient un contrat (D23).**
`packages/contracts/src/auth/access-token.ts`, `AccessTokenClaimsSchema` :
`sub`, `role`, `driverId`, `iat`, `exp`, `jti`. Spécifié dans
`amoa/specs/C-contrats.md`, C-01.

Puis les deux côtés s'y alignent, aucun ne redéclare la forme :
- Odoo : `controllers/auth.py:_issue_access_token` émet `sub` au lieu de `uid`,
  et `driverId` sur un jeton chauffeur. `controllers/_common.py` lit `sub`.
  **Vérifie qu'aucun autre lecteur ne subsiste** — un `claims.get("uid")` oublié
  quelque part produirait exactement le défaut qu'on répare.
- Service temps réel : `ws/token.ts` importe le schéma au lieu de déclarer
  `ApplicationTokenClaims`.

`driverId` porte `babana.driver.public_id`. **Ce n'est pas `sub`**, qui porte
`res.users.babana_public_id`. Deux modèles Odoo distincts : les confondre
affecte une connexion au mauvais chauffeur, et rien ne s'en apercevrait avant
le pilote.

Les jetons déjà émis deviennent invalides. Sans conséquence : aucune app n'est
déployée.

**C2. Le test qui aurait dû exister** — critère 5 de C-01. Un test de bout en
bout obtient un jeton par `/auth/google` contre le vrai Odoo, et ouvre avec lui
une connexion WebSocket acceptée par le vrai service temps réel. `test/
concurrency/helpers/odoo-session.ts` (L4-11) sait déjà faire la première
moitié — réutilise-le plutôt que d'en écrire un second.

Vérifie-le à blanc : remets `uid` un instant, le test doit échouer. Un test qui
n'échoue jamais quand le défaut est là ne prouve rien — c'est ce qu'on a
appris sur L3-13.

**C3. Le compteur de quota de routage.** `services/routing.py:_record_quota_usage`
lit puis écrit `ir.config_parameter` à chaque appel. Comptage faux sous
concurrence, et surtout **une écriture sur une ligne globale par cotation** :
sous `REPEATABLE READ`, c'est la configuration exacte qui a produit le
`SerializationFailure` trouvé par L4-11 sur les courses. Deux clients qui font
estimer au même instant, et l'un des deux reçoit une erreur technique. Le suivi
d'un quota ne doit jamais faire échouer une cotation.

**C4. Repli sur cache périmé (D24).** Quand l'API de routage est injoignable,
servir l'entrée périmée de la même clé si elle existe, en le journalisant. Le
503 ne subsiste que si rien n'a jamais été calculé pour ce trajet. Aujourd'hui
une panne chez Google arrête toute la plateforme. Spécification et critères
réécrits dans `amoa/specs/L2-tarification.md`, L2-05.

**C5. Borne du minuteur d'expiration.** `ws/connection.ts` :
`setTimeout` au-delà de 2³¹−1 ms déclenche immédiatement. Inatteignable avec un
jeton d'une heure, mais C1 rouvre justement la question de sa durée de vie.
Une ligne.

## Points d'attention sur le lot L3

**L3-02 — la validation de plausibilité protège le géo-index, pas les données.**
Une position aberrante (saut de dix kilomètres en deux secondes, précision de
trois kilomètres, coordonnées hors de la zone) n'est pas une donnée à corriger :
c'est une donnée à écarter. Un chauffeur téléporté dans le géo-index sera
proposé à un client qu'il ne peut pas rejoindre.

**Et rappelle-toi l'invariant 1** : une position n'écrit jamais dans Odoo.
Jamais. Redis avec TTL, rien d'autre. Si une tâche semble exiger le contraire,
arrête-toi et écris-le.

**L3-03 — le géo-index est la structure dont dépend toute la suite du lot.**
L3-05 (les 5 plus proches) et L3-06 (la réservation atomique) s'appuieront
dessus. La réservation atomique retirera un chauffeur du pool par un seul script
Redis — écris le géo-index en sachant que ce retrait devra être indivisible,
même si tu ne l'écris pas ce soir.

**L3-04 — hors ligne doit être immédiat et complet.** Un chauffeur qui se met
hors ligne et reste proposé aux clients pendant trente secondes reçoit des
propositions qu'il refuse, et son taux de refus le pénalise. Sortie du pool dans
la même opération que la bascule.

## Protocole — inchangé

Lis les spécifications des tâches dépendantes : pour L3-02 et L3-03, lis L3-05
et L3-06, dont tu prépares le terrain.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`,
toujours.

**Un commit par tâche**, avec son entrée de rapport. La nuit dernière en a
groupé deux paires ; c'était défendable, mais une interruption entre les deux
moitiés d'une paire laisse l'arbre dans l'état intermédiaire que le protocole
cherche à éviter.

Exécute la suite au moins une fois sur une base fraîche avant de déclarer une
tâche finie. Deux nuits de suite, c'est ce qui a distingué un vrai défaut d'un
artefact de base accumulée.

## Rapport

`amoa/rapport-nuit-J6.md`, une entrée écrite et commitée avec chaque tâche.
Même structure que les nuits précédentes.

## Ce que j'attendrai demain matin

Un jeton qui traverse réellement les deux services, prouvé par un test qui
échoue si on le casse. Et un chauffeur qui apparaît dans le géo-index quand il
se met en ligne, qui en sort quand il se met hors ligne.
```

---

## Après cette nuit

Il restera, pour le lot L3 : les 5 plus proches (L3-05), la réservation atomique (L3-06, sous
revue humaine) et son test de concurrence (L3-13), le cycle de proposition (L3-07), le suivi
(L3-09), et les appels sortants vers Odoo (L3-12) — la tâche où la règle de partition se
matérialise ou se perd.

Et L4-05 / L5-01, l'encaissement, toujours en attente de revue. C'est le dernier maillon avant
une course démontrable de bout en bout, encaissement compris.

Et toujours, inchangé depuis cinq jours : **le compte Google Play.** La validation d'identité
prend plusieurs jours et aucune nuit de travail ne la rattrapera.
