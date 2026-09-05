# Prompt de lancement — session de nuit J49

**Deux émetteurs, et un test qui dépend de l'heure.** La dernière avant la recette.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J48, D75/D76, critères 6 et 7 de L6-18 réécrits"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-26.md` et
`amoa/01-architecture.md` §9 septdecies.

Trois choses d'hier soir méritent d'être dites. Tu as signalé le prérequis
manquant avant d'écrire du code plutôt que de fabriquer un contournement. Tu as
ouvert `node_modules` pour vérifier que le paquet natif de Google Sign-In ne
supporte pas le web, au lieu de le supposer. Et tu as relu les sept critères
d'acceptation un par un pour conclure que **L6-18 n'est pas encore close** — en
nommant ce qui manque, pas seulement ce que tu avais fait. C'est exactement le
défaut du 25 septembre, et il ne s'est pas répété.

Deux de ces critères étaient d'ailleurs périmés, et c'est ma faute : ils
décrivaient un déploiement Vercel abandonné en adoptant D46. Réécrits.

## Périmètre de cette session

1. **D75** — plusieurs émetteurs de jeton, choisis par le jeton
2. **D76** — le test de tarification qui dépend de l'heure

## 1. D75 — le jeton porte déjà la réponse

Tu as créé ce cas en réussissant : `GOOGLE_JWKS_URL` n'a qu'une source, donc un
vrai jeton Google et un jeton du simulateur ne peuvent pas coexister. Tu as
basculé, vu ta connexion aboutir, et remis. C'était juste pour une vérification
— ce ne l'est plus pour une démonstration, qui doit montrer **une vraie
connexion à l'écran ET des chauffeurs simulés qui bougent**.

`google_identity.py` route vers le jeu de clés correspondant à l'émetteur
déclaré par le jeton, au lieu d'imposer une adresse unique. C'est plus juste que
la configuration actuelle, qui suppose ce qu'elle pourrait lire.

**Le garde-fou est la moitié importante, pas un complément.**

L'émetteur simulé n'est accepté **que là où l'adresse du simulateur est
configurée** — même forme que D43 : l'absence de valeur supprime la possibilité,
pas un drapeau qu'on peut oublier de baisser. Et `deploy.sh` **refuse** un
déploiement de production qui listerait un émetteur simulé, au même titre qu'il
refuse déjà un `SMTP_HOST=mailpit`.

Sans cette clause, « accepter plusieurs émetteurs » veut dire accepter un
émetteur qui délivre un jeton valide à qui le demande. C'est la porte que D19 a
toujours gardée à l'intérieur du développement.

**Et le test qui compte est celui qui échoue** : un jeton du simulateur présenté
à une configuration de production doit être rejeté, prouvé en le tentant. Pas un
test qui vérifie qu'un jeton valide passe.

Une chose à vérifier plutôt qu'à supposer : l'émetteur que `mock-google-identity`
déclare réellement dans les jetons qu'il signe. C'est lui qui sert de clé de
routage, et je ne l'ai pas lu.

## 2. D76 — un test ne dépend de rien qu'il n'ait posé lui-même

`test_weekday_mask_restricts_applicability` fabrique un « lundi » depuis l'heure
courante sans fixer l'heure du jour ; entre 23 h et minuit UTC, la conversion
vers l'heure de Douala franchit minuit. Tu l'as diagnostiqué proprement et tu as
attendu la fenêtre plutôt que de toucher un fichier hors périmètre — bonne
discipline, et il entre ce soir.

**C'est la cinquième fois qu'un test dépend de quelque chose qu'il n'a pas posé**
— le contenu de la base deux fois, la charge de la machine deux fois, l'heure
maintenant. Alors ne corrige pas seulement celui-ci : le fichier d'écart nomme
`L5-collected-today-timezone-boundary.md` comme la même famille sous un autre
module. Relis-le, et cherche les autres constructions de date à partir de
`now()` dans les lots sensibles. Si tu n'en trouves pas d'autres, dis-le — c'est
un résultat, comme ton balayage du 21 septembre.

## Ce qui reste hors périmètre

Le déploiement de recette. `amoa/09-recette-babana-dev.md` et
`amoa/PROMPT-SERVEUR-RECETTE.md` le portent, et c'est lui qui refermera les deux
derniers critères de L6-18. N'y touche pas.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, `make test` en entier.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J49.md`, et complète la passe de clôture de J41.

Et la question habituelle : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**

## Ce que j'attendrai demain matin

Un chauffeur simulé et une vraie connexion Google dans le même environnement, au
même moment. Et un jeton de simulateur refusé par une configuration de
production, prouvé en le tentant.
```

---

## Après cette nuit

**La recette sur `babana.dev`.** Tout est écrit : la configuration nginx, la plage de ports dédiée,
la surcharge Compose, et le prompt à lancer sur le VPS.

Deux choses de votre côté avant ce déploiement :

- **Les trois enregistrements DNS** — `api.`, `admin.`, `storage.babana.dev` — puis le certificat
  qui couvre les cinq noms.
- **Ajouter le compte Google de votre client comme testeur** dans l'écran de consentement.
  L'application est en mode test : sans ça, il ne pourra pas se connecter le jour de la
  démonstration.
