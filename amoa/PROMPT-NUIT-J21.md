# Prompt de lancement — session de nuit J21

**Objectif** : la suite redevient verte, et l'écran de suivi cesse d'être vide là où il compte.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J20, D45 fuseau posé à l'inscription, D46 le banc reproduit la production"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-29.md`.

Tu as laissé la suite rouge sur deux tests, et tu as eu raison : le défaut est
compris, isolé, et sa correction appartient à un lot sous revue humaine. C'est
la première tâche de cette nuit.

## Périmètre de cette session

1. **D45** — le fuseau posé à l'inscription, et les bornes de jour converties
   en UTC
2. **D46** — le banc de vérification en même origine, pas de CORS sur l'API
3. **L8-03** — partage de trajet
4. **L8-04** — bouton d'urgence

**Si le lot ne passe pas en entier, arrête-toi après L8-04 ou avant, jamais au
milieu de l'une des deux.**

## D45 — les deux moitiés, et il les faut toutes les deux

Le fuseau se pose à la création du compte : `Africa/Douala`, **paramétrable**
(le jour où le service dépasse le Cameroun, cette valeur doit changer sans
toucher au code).

Et toute borne dérivée d'un jour calendaire se convertit en UTC avant de servir
à une requête. Cherche s'il y en a d'autres que `_babana_cash_collected_today` —
c'est le genre de motif qui se recopie.

Corriger l'une sans l'autre laisse un décalage d'une heure à Douala : plus rare,
donc plus difficile à voir. C'est exactement le piège de D40, une couche plus
bas.

**Ce qui se teste, c'est la frontière.** Un test qui tourne à quatorze heures ne
dira jamais rien. Celui qui a trouvé ce défaut l'a fait par accident d'horaire ;
le prochain ne doit rien devoir au hasard.

Ce lot touche le calcul de solde : c'est de la logique financière, sous revue
humaine. Écris-le comme tel.

## D46 — je corrige ta conclusion, pas ton constat

Ton constat est juste : préflight en 401, aucune gestion CORS nulle part, tout
`/api/v1/*` concerné.

Mais en production, Caddy sert le bundle **et** proxifie l'API sous le même
domaine (D18) : CORS ne s'y applique jamais. C'est ton banc qui utilise deux
origines — celui de J16 était en même origine, celui de cette nuit ne l'est
plus.

Ajouter des en-têtes CORS à une API qui porte des jetons pour satisfaire un banc
d'essai ouvrirait une vraie surface d'attaque pour accommoder une erreur de
montage.

**La règle générale** : quand une vérification révèle un problème que la
production n'aura pas, c'est la vérification qu'on corrige. Sinon on durcit le
produit contre des contraintes imaginaires, et on manque les vraies.

Ta prudence de ne pas improviser une politique CORS en fin de nuit était juste.

## L8-03 et L8-04 — cinq nuits que je les reporte

Ce sont les seules fonctions du produit qui touchent à la sécurité des
personnes. Trois points.

**Elles doivent être atteignables en un geste depuis l'écran de suivi**, pas
enfouies dans un menu. Leur utilité tient entièrement à leur accessibilité en
situation de stress — quelqu'un qui a peur ne cherche pas dans un menu.

**Le partage de trajet doit fonctionner pour le destinataire sans qu'il ait
l'application.** Un lien qu'on envoie par WhatsApp — c'est ce que les gens
utilisent ici — et qui s'ouvre dans un navigateur. Un partage qui suppose que le
proche a installé l'app ne sert à personne.

**Le bouton d'urgence doit laisser une trace côté back-office**, pas seulement
composer un numéro. Une alerte qui ne remonte nulle part est une alerte que
personne ne traite, et c'est le superviseur qui doit savoir qu'il s'est passé
quelque chose.

Et l'écran de suivi cesse alors d'afficher ces deux fonctions comme absentes.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus — et cette fois elle doit
être verte, y compris dans la fenêtre horaire qui l'a fait rougir.

**La vérification navigateur**, jusqu'au résumé de fin : c'est le critère 5 de
L3-19, et il n'a toujours jamais pu être tenu — d'abord la recherche de lieu,
puis le préflight. Cette nuit devrait être la bonne.

Lis les spécifications des tâches dépendantes : pour L8-03 et L8-04, lis L6-09
(l'écran qui les accueille) et L9-* pour la vue back-office.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J21.md`, une entrée par tâche, commitée avec elle.

Et la même question : **qu'est-ce qui te laisse un doute pour un client réel ?**

## Ce que j'attendrai demain matin

Une suite verte à n'importe quelle heure. Et un parcours complet dans un
navigateur, de la carte au résumé de fin, avec un bouton d'urgence qui laisse
une trace.
```

---

## Après cette nuit

Le parcours Client sera complet et sûr. Restera le **lot Chauffeur** — c'est ce qui manque à sept
des douze messages orphelins de la cartographie, et le contrat comme le serveur sont prêts.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et toujours, à délai subi : **la validation du plan comptable** — trois questions, dont la TVA — et
**la vérification développeur Android**.
