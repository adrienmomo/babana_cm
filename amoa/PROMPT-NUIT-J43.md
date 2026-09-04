# Prompt de lancement — session de nuit J43

**Courte.** Un angle mort, et le dépôt est prêt.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J42, D68 -- l'échec du journal doit se voir ailleurs que dans le journal"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-19.md` et
`amoa/01-architecture.md` §9 decies.

L8-09 est bien construite. J'ai vérifié les deux endroits où elle pouvait mal
tourner — le savepoint et l'ordre des appels — et les deux tiennent. Ce que je
te demande ce soir ne corrige pas une erreur : il ferme un angle mort né de la
composition de deux décisions justes.

## Périmètre de cette session

**D68** — l'échec du journal d'audit se signale ailleurs que dans le journal
qu'il remplace.

## Le raisonnement

Le journal ne lève jamais (critère 3, et c'est juste : un journal qui bloque les
courses serait désactivé le premier jour d'incident). L'écriture y est interdite
à tous (critère 2, juste aussi).

Ensemble : si l'écriture casse un jour, l'opération continue, rien ne lève,
aucune entrée n'est créée — et la seule trace part dans `_logger.exception`,
c'est-à-dire dans le journal applicatif ordinaire que L8-09 existe pour
remplacer. **La traçabilité peut s'arrêter sans que personne ne l'apprenne**, et
on s'en apercevra le jour du litige, en cherchant une entrée qui n'a jamais été
écrite.

C'est D57, que tu as portée toi-même le 15 septembre pour l'envoi de facture :
un mécanisme automatique dont l'échec est invisible est pire que le geste manuel
qu'il remplace, parce qu'il retire le dernier humain qui aurait pu constater
l'absence. Même forme, autre objet.

## Ce que j'attends

**Un échec d'écriture du journal se voit là où un administrateur regarde déjà.**
La forme est à toi — tu as choisi la bonne pour la facture (un état calculé, un
badge, un ruban, un filtre) et tu connais mieux que moi ce que porte cet écran.
Deux exigences seulement.

**Le signal ne vit pas dans le journal.** Un compteur d'échecs stocké dans
`babana.audit.log` serait circulaire : si l'écriture casse, le compteur casse
avec. Il lui faut un support qui ne dépende pas de ce qui vient d'échouer.

**Le test provoque l'échec**, il ne vérifie pas qu'un succès réussit. Tu as déjà
`TestAuditLogNeverBlocksBusinessOperation` qui patche `create` pour lever : c'est
exactement le montage dont tu as besoin, il lui manque l'assertion sur la
visibilité.

Et si en le construisant tu trouves que le bon signal est ailleurs — une sonde
de supervision plutôt qu'un écran, par exemple —, dis-le plutôt que de suivre ma
formulation. C'est un choix d'implémentation, il t'appartient.

## Si le périmètre te paraît court

Il l'est volontairement. Deux choses valent mieux qu'un remplissage, si tu as le
temps :

- **`GET /api/v1/driver/documents`**, que tu as nommé toi-même comme non
  journalisé. Ton raisonnement est bon (lire un statut n'est pas accéder à une
  pièce) et je le retiens — mais si tu changes d'avis en y revenant à froid,
  c'est le moment.
- **`nearby.test.ts`**, le seul des trois tests instables resté sans théorie.
  Vu une fois le 15 septembre, jamais reproduit. Si tu as une idée, elle vaut
  plus qu'une tâche neuve.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, `make test` en entier.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J43.md`, et **complète la passe de clôture de J41** plutôt
que d'en écrire une troisième — c'est le document qu'on lira à la reprise, il
doit rester à un seul endroit.

## Ce que j'attendrai demain matin

Un administrateur qui apprend que la traçabilité s'est arrêtée, sans avoir à
ouvrir un fichier de logs.
```

---

## Après cette nuit

**Le développement du périmètre pilote est fini.** Les nuits reprennent quand le terrain aura
parlé.

La suite est dans `amoa/08-passation-pilote.md` — l'ordre dans lequel arriver aux premières
courses, et les chiffres à relever dès le premier jour.
