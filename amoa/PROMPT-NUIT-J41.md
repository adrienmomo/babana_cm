# Prompt de lancement — session de nuit J41

**La dernière nuit avant le pilote.** Le filet qui protège tout le reste, et une passation.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J40, D65/D66, OTP hors périmètre pilote, L3-14 corrigée"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-09-17.md`.

Hier, tu as cherché POURQUOI un repli s'exécutait au lieu de le supprimer, et
tu as trouvé que chaque lien de partage de trajet portait le domaine de
production en dur depuis le premier jour. C'est la meilleure trouvaille de la
semaine, et elle vient d'une question, pas d'un correctif.

Une remarque de protocole avant de commencer : les sessions d'hier ont écrit
directement dans `amoa/01-architecture.md`, sans le mentionner au rapport. Le
contenu était juste — c'est ce qui rend la remarque nécessaire. Le rapport est
le canal de « voici ce que j'ai trouvé » ; ce document est celui de « voici ce
que nous décidons ». Quand les deux se confondent, je ne relis plus, je ratifie.

**C'est la dernière nuit du périmètre pilote.** Ce qui suit dépend du terrain.

## Périmètre de cette session

1. **L10-01** — les scénarios de bout en bout
2. **D65** — la livraison d'une variable vérifiée par service
3. **Une passe de clôture**

## 1. L10-01 — le filet qui protège tout le reste

La boucle complète, plus les variantes : refus puis nouvelle sélection,
annulation, plafond d'encaisse, remise de caisse, notifications désactivées.
Contre l'environnement réel, en simulé, donc exécutable sans aucun secret.

Trois points.

**Ces scénarios ne rejouent pas les tests unitaires en plus gros.** Ils
protègent les chemins qui traversent plusieurs composants — c'est là que ce
projet a trouvé ses défauts les plus coûteux : le jeton entre Odoo et le temps
réel, l'état de course entre Redis et PostgreSQL, l'URL signée entre le
conteneur et le navigateur. Trois fois, la faille était sur le chemin, jamais
dans une pièce.

**Ils empruntent le vrai chemin de bout en bout.** L3-12 t'a déjà appris qu'une
préparation de test qui prend un raccourci laisse une réservation en place et
un minuteur armé. Un scénario qui triche sur son montage teste un système qui
n'existe pas.

**Et ils doivent échouer quand quelque chose casse.** Comme pour L3-13 et
L3-14 : casse délibérément un maillon, vérifie que le scénario le voit, remets
en place. Tu l'as fait de toi-même deux fois cette semaine.

## 2. D65 — le contrôle qui n'a pas vu le défaut qu'il cherchait

`tools/config-coherence` traite « livrée » comme un booléen : la variable
apparaît quelque part dans un fichier compose, donc elle est livrée. Il ne sait
ni à quel service, ni où s'exécute le code qui la lit — c'est pour ça qu'il
était vert sur `BABANA_DOMAIN`.

La livraison se vérifie **par service** : `services/odoo/` contre le bloc
`environment` du service `odoo`, `services/realtime/` contre celui de
`realtime`, `apps/` contre l'environnement du build.

Le critère 1 bis se prouve sur le cas réel : retire `BABANA_DOMAIN` du bloc
`odoo`, la suite doit échouer. J'ai vérifié qu'aucun autre cas ne subsiste
aujourd'hui — le dépôt est propre par ton correctif d'hier, pas par
construction. C'est cette nuit qu'il le devient par construction.

## 3. La passe de clôture — écris pour quelqu'un qui reprend dans trois semaines

Les nuits s'arrêtent après celle-ci : ce qui reste est de la calibration, et
elle a besoin des données du pilote pour être juste.

Alors laisse le dépôt dans l'état où tu voudrais le trouver. Pas une
documentation — un état des lieux. Dans `amoa/rapport-nuit-J41.md`, une dernière
section :

- **Ce qui est rouge ou instable.** Le flake de `nearby.test.ts` (L3-20), celui
  de `reservation.test.ts`, et tout ce que tu as vu passer sans le reproduire.
  Trois en cinq nuits — dis lesquels, et ce que tu en penses.
- **Ce qui est vert mais que personne n'a jamais exercé pour de vrai.** Tu en
  connais au moins trois : `bootstrap.sh` jamais lancé, FCM jamais confronté à
  un vrai compte Firebase, la latence du fil de fond jamais mesurée sous charge.
  Il y en a d'autres. C'est la liste la plus utile que tu puisses laisser.
- **Ce que tu as supposé et qui n'a jamais été vérifié.**
- **Les champs-pont encore vivants**, avec la tâche qui devait les faire
  disparaître.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

`make reset`, `make seed`, la passe finale.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

## Rapport

`amoa/rapport-nuit-J41.md`, une entrée par tâche, commitée avec elle, plus la
passe de clôture.

Et pour cette dernière nuit, la question change : **si tu devais prévenir d'une
seule chose la personne qui lancera les premières vraies courses, ce serait
laquelle ?**

## Ce que j'attendrai demain matin

Une boucle complète qui tourne sans secret, et un état des lieux qu'on peut lire
dans trois semaines sans avoir rien perdu.
```

---

## Après cette nuit

**Le développement du périmètre pilote est fini.** Les nuits reprennent quand le terrain aura
parlé — la calibration (ETA, seuils, tarifs réels) a besoin des données du pilote pour être juste,
et la faire avant reviendrait à deviner.

Ce qui reste dépend entièrement de vous, et rien n'attend rien :

| Ce qui reste | Latence propre |
|---|---|
| **VPS + DNS** (quatre noms : apex, `api.`, `admin.`, `storage.`) | Des heures — et la démonstration suit immédiatement |
| **Relais SMTP** | Souscription immédiate, vérification du domaine plusieurs jours |
| **Compte Google Cloud** | Des heures |
| **Restauration sur un hôte vierge** | Une soirée — et sans elle L8-08 n'est pas finie |
| **Une demi-journée avec un téléphone** (L6-19) | Une demi-journée — sans le sélecteur de pièces, aucun chauffeur ne s'inscrit |
| **Validation du plan comptable** | Votre comptable |

**L'OTP est sorti du périmètre (D66)** — et le chiffre à relever pendant le pilote est le nombre
de courses échouées faute de pouvoir joindre le passager. C'est lui qui dira si la passerelle SMS
est une commodité ou une nécessité.
