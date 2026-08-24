# Prompt de lancement — session de nuit J22

**Objectif** : comprendre pourquoi un flux meurt, puis ouvrir la seconde application.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J21, D47 surveillance par flux, D48 le superviseur d'abord, L3-20"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-30.md`.

Ton diagnostic du silence de diffusion est le meilleur du projet — trois causes
éliminées avec des preuves, et un déclencheur isolé à la seconde près. Cette
nuit commence par le finir.

## Périmètre de cette session

1. **L3-20** — le diagnostic d'abord, puis la détection de silence par flux
2. **L6-11** — bascule en ligne / hors ligne, chauffeur
3. **L6-12** — réception de proposition : départ, arrivée, montant, distance,
   compte à rebours, accepter ou refuser

**Si le lot ne passe pas en entier, arrête-toi après L6-11.**

## L3-20 — le diagnostic avant le mécanisme

Ton hypothèse est plausible : une exception avalée dans le rappel périodique,
qui l'empêcherait de se réarmer sans jamais toucher au premier envoi. Vérifie-la
avant de construire quoi que ce soit.

**Si tu ajoutes la surveillance sans avoir trouvé la cause, tu poses une alarme
pour ne pas réparer la serrure** — et si la cause est bien une boucle qui cesse
de se réarmer, la surveillance la rendra simplement moins visible.

**Et je corrige ta proposition sur un point qui compte.** Tu proposais un
battement de cœur sur la connexion. Il ne suffit pas : deux pannes produisent le
même silence.

- Une connexion à moitié fermée — le cas courant sur un réseau mobile, pas
  l'exception. Rien n'arrive, `onclose` ne se déclenche jamais.
- Un flux mort sur une connexion vivante — ton cas de cette nuit.

Dans le second, le battement de cœur arriverait normalement et **confirmerait
que tout va bien pendant qu'un flux est mort**. La surveillance se fait donc
par abonnement : un flux périodique connaît sa cadence, donc il sait ce que son
silence signifie.

**Deux exigences à ne pas manquer.** Le dire à l'utilisateur compte autant que
se réabonner — « position datée de N secondes » vaut mieux qu'un marqueur figé.
Et le réabonnement automatique ne doit jamais devenir le comportement qui
aggrave la limitation de débit : c'est la trappe que ce mécanisme ouvre
naturellement.

## L6-11 et L6-12 — l'écran qu'on regarde en conduisant

C'est la première fois que tu écris pour quelqu'un qui n'est pas assis.

**Les cibles tactiles sont grandes** (D20, exigence non esthétique) : le
chauffeur est sur sa moto, parfois avec des gants.

**L'état en ligne / hors ligne est visible en permanence**, sans avoir à
chercher. Un chauffeur qui se croit en ligne alors qu'il ne l'est pas attend des
courses qui n'arriveront jamais.

**Le compte à rebours de L6-12 est indicatif ; le serveur est seul juge de
l'expiration.** Une acceptation qui arrive après l'expiration échoue proprement
— c'est le cas de course le plus probable du projet, parce que le réseau est
lent : le chauffeur appuie à temps, le message arrive en retard.

**Et le refus doit être aussi accessible que l'acceptation.** Un chauffeur qui
ne peut pas refuser facilement laissera expirer — ce qui coûte trente secondes
au client, alors qu'un refus explicite lui en fait gagner autant.

Le bouton d'urgence chauffeur existe déjà, testé en isolation, et attend son
écran — mais c'est L6-13, pas cette nuit.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset` et la passe finale complète sont dus.

**La vérification navigateur** — et cette fois, si le silence est corrigé, le
parcours complet devrait enfin passer jusqu'au résumé de fin. C'est le critère 5
de L3-19, ouvert depuis quatre nuits.

Lis les spécifications des tâches dépendantes : pour L6-12, lis L6-13 et L3-07.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J22.md`, une entrée par tâche, commitée avec elle.

Et la même question, qui vaut double pour un écran de chauffeur : **qu'est-ce
qui te laisse un doute pour quelqu'un de réel ?**

## Ce que j'attendrai demain matin

La cause du silence, nommée. Et un chauffeur qui se met en ligne depuis son
application, reçoit une vraie proposition, et l'accepte.
```

---

## Après cette nuit

Restera, côté Chauffeur : L6-13 (course en cours, qui accueillera le bouton d'urgence déjà écrit),
L6-14 (encaissement) et L6-15 (inscription et documents). Puis L6-05, la capture GPS — la tâche la
plus sensible du lot pour la batterie, et celle que L6-17 devra mesurer.

Côté serveur : L3-12 (la file de rejeu) et L4-06 (la facture).

Et trois démarches à délai subi, dont deux commerciales : **la passerelle SMS** (un fournisseur,
deux usages), **la validation du plan comptable** et **la vérification développeur Android**.
