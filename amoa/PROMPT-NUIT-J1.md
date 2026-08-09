# Prompt de lancement — session de nuit J1

---

## Préparation, cinq minutes

Depuis `babana.cm/` :

```bash
cp amoa/CLAUDE.md CLAUDE.md      # Claude Code le lit au démarrage de la session
mkdir -p code amoa/questions
git init                          # si ce n'est pas déjà fait
git add -A && git commit -m "amoa: documents de référence et spécifications"
```

Arborescence attendue au lancement :

```
babana.cm/
├── CLAUDE.md          ← copie de amoa/CLAUDE.md, lue automatiquement
├── amoa/              ← lecture seule pendant la nuit
│   ├── 01-architecture.md … 05-prerequis-et-simulation.md
│   ├── specs/
│   └── questions/     ← vide, se remplira
└── code/              ← vide, tout le code y sera produit
```

Trois vérifications avant de lancer :

1. Docker fonctionne
2. **La machine ne se met pas en veille** — c'est la cause la plus banale d'une session qui meurt à une heure du matin
3. Vous acceptez que des branches git soient créées

Lancer Claude Code **depuis `babana.cm/`**, pas depuis `code/` ni `amoa/`.

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis d'abord `CLAUDE.md` en entier, en particulier la section « Organisation du
dépôt ». Puis `amoa/03-decoupage-taches.md` §5 et §7.

## Localisation, à retenir avant tout

- `amoa/` contient les décisions et les spécifications. **Lecture seule cette
  nuit**, sauf pour déposer un écart dans `amoa/questions/` et tenir le rapport.
- `code/` est vide et recevra **tout** ce que tu produis.
- **Les chemins des spécifications sont relatifs à `code/`.** Quand une
  spécification dit `services/odoo/addons/babana/`, cela signifie
  `code/services/odoo/addons/babana/`. Quand elle dit `docs/contracts/...`, cela
  signifie `code/docs/contracts/...` — la documentation technique produite par le
  développement, distincte de `amoa/`.
- Un seul dépôt git, à la racine. Les branches couvrent l'ensemble.

Ne crée aucun fichier à la racine hormis ceux qui y sont attendus : `CLAUDE.md`,
`README.md`, `.gitignore`.

## Périmètre de cette session

Objectif : le jalon J1. Un dépôt qui démarre, avec les contrats figés.

Lot autorisé, dans cet ordre :

1. C-03 — machine à états de la course
2. C-01 — contrat d'API mobile ↔ Odoo
3. C-02 — contrat d'événements temps réel
4. L0-01 — infrastructure Docker
5. L0-02 — squelette du module Odoo babana
6. L0-08 — services simulés
7. L0-03 — monorepo React Native
8. L0-04 — squelette du service temps réel
9. L0-06 — environnements et secrets

N'entreprends aucune tâche hors de cette liste, même si elle semble facile ou
naturelle. Les suivantes dépendent de décisions que je dois valider.

## Méthode, tâche par tâche

1. Lis la spécification complète dans `amoa/specs/`
2. Crée une branche nommée d'après l'identifiant : `C-03-ride-state-machine`
3. Implémente, dans `code/`
4. Écris les tests couvrant chaque critère d'acceptation
5. Vérifie les sept points de la définition de fini du `CLAUDE.md`
6. Commite avec l'identifiant en préfixe
7. Fusionne dans `main` si et seulement si tous les critères passent
8. Consigne le résultat dans `amoa/rapport-nuit.md` avant de passer à la suivante

Le point 8 est important : écris au fil de l'eau, pas à la fin. Si la session
s'interrompt, je dois pouvoir savoir où tu en étais.

## Règle d'écart adaptée à une session non surveillée

Le protocole normal dit de s'arrêter et de demander. Cette nuit, personne ne
répondra. Applique donc ceci à la place :

**Si une spécification est ambiguë, fausse, ou contredit une autre :**
- N'invente pas silencieusement une interprétation
- Écris la question dans `amoa/questions/<ID-TACHE>.md` : ce que la spécification
  demande, pourquoi cela pose problème, les options que tu vois, et laquelle tu
  recommanderais
- Si tu peux avancer avec une hypothèse explicite, fais-le : note l'hypothèse en
  tête du fichier de question et dans le message de commit
- Si tu ne peux pas avancer, abandonne la tâche et passe à la suivante qui n'en
  dépend pas

**Ne corrige jamais une spécification de toi-même.** Dépose la question, applique
une hypothèse, avance. Une spécification réécrite en silence pour arranger le
code annule tout l'intérêt de ce protocole.

**Si une tâche exigerait de violer un des cinq invariants : ne la fais pas.**
Écris la question, passe à la suivante. Un invariant violé coûte plus cher qu'une
tâche non faite.

**Si un test échoue et que tu ne comprends pas pourquoi :** ne le désactive pas,
ne modifie pas l'attendu. Laisse-le rouge, documente-le, passe à la suite. Un
test rouge documenté vaut mieux qu'un test vert falsifié.

**Ne demande jamais de confirmation.** Si tu hésites entre deux choix
d'implémentation non spécifiés — nommage, structure de fichiers, bibliothèque
utilitaire — décide, avance, mentionne-le dans le commit.

## Points d'attention connus

**L0-03 est la tâche la plus risquée du lot.** La résolution de modules Metro
dans un monorepo React Native est capricieuse. Si tu t'enlises plus d'une heure
dessus, documente précisément où, et passe à L0-04 et L0-06 qui n'en dépendent
pas. Mieux vaut un monorepo à finir demain que trois heures perdues cette nuit.

**L0-08, le service d'identité simulé** : n'ajoute jamais de branche
`if development` dans la vérification de jeton. On simule le fournisseur, jamais
notre logique. Si tu es tenté de court-circuiter la vérification, c'est que la
conception est à revoir — écris la question.

**Aucun compte externe n'est disponible cette nuit.** Tout doit fonctionner en
simulé (D19). Si une tâche semble exiger une clé d'API réelle, c'est un écart :
documente-le.

**Aucune valeur métier n'est validée.** Utilise des valeurs plausibles marquées
provisoires, jamais aléatoires (D21). Les tarifs et plafonds vont en base, pas
dans le `.env`.

## Rapport du matin

Tiens `amoa/rapport-nuit.md` à jour au fil de l'eau. Structure :

### État par tâche

Un tableau : identifiant, statut (finie, partielle, abandonnée, non commencée),
branche, et une ligne de commentaire.

### Ce qui tourne

Les commandes exactes qui fonctionnent, avec ce qu'elles produisent, et depuis
quel répertoire. Si `make up` démarre, dis-le et dis combien de services sont
sains. Si ça ne démarre pas, dis à quelle étape ça casse.

### Ce qui ne tourne pas

Chaque échec, avec le message d'erreur exact et ce que tu as tenté. Ne résume
pas les erreurs, cite-les.

### Questions ouvertes

Un renvoi vers chaque fichier de `amoa/questions/`, avec une phrase de résumé et
le degré d'urgence : bloquant pour la suite, ou à trancher plus tard.

### Hypothèses prises

Chaque décision que tu as prise à ma place, et pourquoi. C'est la section que je
lirai en premier.

### Ce que je ferais ensuite

Ta recommandation sur la prochaine tâche, au vu de ce que tu as appris.

## Ce que j'attendrai demain matin

Je ne m'attends pas à ce que les neuf tâches soient finies. Je m'attends à un
état clair : ce qui marche, ce qui ne marche pas, ce sur quoi j'ai besoin de
trancher.

Les questions accumulées m'intéressent probablement plus que le code. Ces
spécifications n'ont encore été confrontées à rien — cette nuit est autant un
test des spécifications qu'une session de développement. Si une spécification
s'avère fausse, c'est une information utile, pas un échec.
```

---

## Demain matin, dans cet ordre

**Lire `amoa/questions/` avant de lire le code.** C'est là qu'est la valeur : chaque question est une spécification à corriger, et une correction faite maintenant coûte cent fois moins qu'après quarante tâches construites dessus.

**Vérifier les hypothèses prises.** Une hypothèse raisonnable mais fausse se propage silencieusement. C'est le seul endroit où une session non surveillée peut coûter cher.

**Répercuter les corrections dans `amoa/specs/` et dans les documents d'architecture**, pas seulement dans le code. Une spécification laissée fausse reproduira la même erreur à la tâche suivante.
