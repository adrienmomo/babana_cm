# Prompt de lancement — session de nuit J46

**Un seul sujet, court.** Le délai qui manque, et le filet qu'il rend possible.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J45, D70 close, D71 -- un délai sur callOdoo"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-22.md` et
`amoa/01-architecture.md` §9 terdecies.

Ta nuit d'hier est la meilleure investigation du projet. Deux choses en
particulier.

Tu as trouvé que la reproduction exigeait la commande réelle, pas le fichier
isolé — et c'est ce qui explique trois nuits de faux diagnostics : isoler ce
qu'on soupçonne détruit la condition qui produit le défaut. Chaque « rejoué
seul, vert, donc environnemental » était garanti d'avance.

Et tu as pris les mesures pendant le figement, pas après. C'était ce qui
manquait, et ça a suffi.

## Le sujet de cette nuit

**D71 : `callOdoo` n'a aucun délai.** Tu l'avais relevé hier sans le traiter, et
tu avais raison — je t'avais interdit le correctif défensif sans preuve.

Ce que ma revue ajoute, et qui change la nature de la chose : ce n'est pas une
précaution spéculative, c'est une inconsistance avec une hypothèse que le dépôt
pose partout ailleurs. J'ai vérifié tous les appels sortants du système — Odoo
vers le routage, vers le service temps réel, vers les notifications, vers le jeu
de clés Google, et ton `pingOdoo` — **tous portent un délai. Les deux seuls qui
n'en ont pas sont ceux qui transportent le travail réel.**

## Pourquoi ça compte plus qu'une attente

Regarde ce qui est empilé derrière `callOdoo` :

- une **boucle de réessai** — trois tentatives, délai croissant. Un premier
  appel qui ne se termine jamais n'atteint jamais le deuxième.
- derrière elle, **la file de rejeu** que tu as construite en J36, pour qu'un
  refus dont l'appel Odoo échoue ne bloque pas une course pour toujours. Elle se
  déclenche sur un échec. Un appel qui se tait n'échoue pas.

**Tout l'édifice de récupération suppose qu'Odoo réponde ou refuse, jamais qu'il
se taise.** C'est ton défaut d'hier soir, une couche plus bas : un rattrapage
placé derrière quelque chose qui peut se taire ne s'exécute jamais. Le `finally`
attendait une exception qui sautait par-dessus lui ; la file attend un échec qui
ne vient pas.

Un délai n'est donc pas une protection contre la lenteur. C'est **ce qui
transforme un silence en échec**, donc ce qui permet à tout ce qui est derrière
d'exister.

## Ce que j'attends

**Le délai, paramétrable** (invariant 5), sur le même patron que `pingOdoo` juste
au-dessus. Sa valeur mérite une phrase de justification dans le commentaire : ce
n'est pas un chiffre neutre, il borne le temps qu'une acceptation de course peut
prendre avant d'être considérée comme perdue et remise en file.

**Et la vérification compte autant que le correctif.** Elle est le vrai objet de
la nuit : provoque un Odoo qui se tait — pas qui refuse, qui se tait — et prouve
la chaîne complète. Un échec, puis un réessai, puis une entrée de file, puis un
rejeu qui aboutit au retour d'Odoo. C'est la première fois que ce chemin serait
exercé de bout en bout ; L3-12 l'a construit contre un Odoo qui refuse, jamais
contre un Odoo muet.

Si en le faisant tu découvres que la file ne prend pas le relais comme prévu,
c'est la trouvaille de la nuit et elle passe devant le reste.

**Regarde aussi le réessai lui-même** : trois tentatives avec délai croissant,
chacune désormais bornée — le temps total avant que la file ne prenne la main
devient prévisible pour la première fois. Vérifie qu'il reste compatible avec ce
qu'un chauffeur voit à l'écran quand il accepte une course. Un chauffeur qui
attend une confirmation n'attend pas trois délais empilés sans rien savoir.

## Ce qui reste ouvert, et que je ne te demande pas de traiter

Le dépassement occasionnel de `waitForDriverVisible` — tu l'as nommé, il reste
sans explication, et le figement ne le masque plus. Rien à corriger tant qu'on
ne sait pas ce qu'il mesure. S'il se reproduit cette nuit, note ce que tu vois.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J46.md`, et **complète la passe de clôture de J41** — c'est
le document qu'on lira à la reprise, et après cette nuit il devient le document
principal.

## Ce que j'attendrai demain matin

Une course acceptée pendant qu'Odoo se tait, remise en file, et qui aboutit
toute seule quand il revient.
```

---

## Après cette nuit

**Il ne reste plus rien que le terrain ne doive trancher.**

La suite est dans `amoa/08-passation-pilote.md` : les six démarches et leur latence propre, l'ordre
si vous en voulez un, les six points à vérifier avant d'ouvrir à de vrais chauffeurs, et les trois
chiffres à relever dès le premier jour.

**Le relais SMTP n'a toujours pas commencé.** C'est la plus longue des six, et la seule dont le
délai cesse de dépendre de vous une fois lancée.
