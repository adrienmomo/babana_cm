# Prompt de lancement — session de nuit J44

**Deux assertions qui mesurent l'histoire au lieu du scénario, et un bouton invisible.**

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J43, D69 -- une assertion bornée à son propre scénario"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-20.md` et
`amoa/01-architecture.md` §9 undecies.

Ton rapport d'hier est le meilleur du projet. D68 s'est validée elle-même en
quelques heures : le silence qu'elle devait rendre visible existait déjà, depuis
la veille, et rien d'autre ne l'aurait révélé.

Et le §5 — celui où tu écris qu'une de tes conclusions était fausse — vaut plus
que les trois défauts. C'est lui qui rend le reste du rapport crédible.

## Périmètre de cette session

1. **D69** — les assertions non bornées
2. **Le `<footer>` du tableau de bord de caisse** (L9-05)

## 1. D69 — tu avais raison de douter, la cause n'est pas la base

L'échec L5 que tu as rencontré (45 850 contre 45 000) n'était pas un paramètre
dérivé. Il est dans les trois dernières lignes du test :

    total_credited = sum(
        self.env["account.move.line"]
        .search([("account_id", "=", int(receivable_account))])
        .mapped("credit")
    )

Ce `search` n'est borné par rien. Il somme tous les mouvements du compte de
créance présents dans la base, jamais les deux que le scénario vient de
produire. Sur une base vide, les deux nombres coïncident et le test paraît
juste.

`test_discrepancy.py` porte le même motif sur le même compte.

Deux points.

**Ce ne sont pas des tests instables, ce sont des tests qui prouvent autre chose
que ce qu'ils annoncent.** Dans le lot que `CLAUDE.md` place sous revue humaine
obligatoire, et pour la raison exacte qui justifie cette revue. Ils cesseront de
valider quoi que ce soit au moment précis où le pilote démarrera.

**Borne-les à leur scénario** — les pièces de cette remise, les mouvements de ce
chauffeur — jamais « tout ce que porte ce compte ». Et vérifie que le test
corrigé échoue toujours si la règle qu'il protège casse : une assertion trop
bornée ne prouverait rien non plus.

Puis **balaie les quatre lots sensibles** — moteur de cotation, machine à états,
mouvements de compte courant, réservation atomique. Ce sont ceux dont
`CLAUDE.md` exige la couverture de tous les chemins, et une agrégation non
bornée y prouve moins qu'elle ne le prétend. Si tu n'en trouves pas d'autres,
dis-le : c'est un résultat.

## 2. Le tableau de bord de caisse

Tu l'as nommé hier et laissé hors périmètre, à juste titre. Il y entre ce soir :
son bandeau dit « utiliser "Actualiser" ci-dessous » et il n'y a pas de
« ci-dessous ».

J'ai balayé les trois vues du module qui portent un `<footer>` : le simulateur
tarifaire et le formulaire de décision chauffeur s'ouvrent en boîte de dialogue,
ils vont bien. Celui-ci est le seul autre atteint — ta trouvaille était
complète.

**Et ouvre-le** (point 9). Un écran décrit comme « ouvert et vérifié » par un
rapport antérieur portait ce défaut : le point 9 ne garantit pas qu'on ait
regardé la bonne chose, seulement qu'on ait regardé. Clique le bouton après
l'avoir déplacé.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale — et note le coût réel de la première
installation sur volume vide, que tu as documenté hier : c'est utile à la
personne qui déploiera.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J44.md`, et **complète la passe de clôture de J41** — c'est
le document qu'on lira à la reprise, il reste à un seul endroit.

## Ce que j'attendrai demain matin

Deux assertions qui disent la vérité sur une base pleine. Et un bouton
« Actualiser » qui existe là où le bandeau dit qu'il est.
```

---

## Après cette nuit

**Le périmètre pilote est fini.** Les nuits reprennent quand le terrain aura parlé.

La suite est dans `amoa/08-passation-pilote.md` : les six démarches, l'ordre, les six points à
vérifier avant d'ouvrir à de vrais chauffeurs, et les trois chiffres à relever dès le premier jour.

**Et une chose que J43 rend plus urgente qu'elle ne l'était** : le compte administrateur
n'appartenait à aucun groupe Babana sur une installation réellement neuve — corrigé cette nuit,
mais jamais éprouvé ailleurs que sur cette machine. **La procédure de mise en production traverse
ce chemin-là pour la première fois.** C'est le §4 de la passation, et c'est pour ça qu'il existe.
