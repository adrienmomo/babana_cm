# Prompt de lancement — session de nuit J10

**Objectif** : débloquer la production, refermer trois défauts d'architecture, puis ouvrir la
logique financière.

---

## À faire avant de lancer

```bash
cd /Users/adrien/workspace/babana.cm
git add -A
git commit -m "amoa: débrief J9, D30 profil dégradé, D31 chemin unique, D32 appel au commit"
```

---

## Le prompt

```
Tu travailles sur babana.cm. Le répertoire courant est la racine du projet.

Lis `CLAUDE.md` en entier, puis `amoa/questions/REPONSES-2026-08-18.md`.

La nuit dernière a livré le câblage et il tient. Trois arbitrages en découlent,
dont un défaut que j'ai trouvé en relisant et qui n'est dans aucun de tes
écarts : le §4.

## Périmètre de cette session

Deux blocs, dans cet ordre. Le second ne commence que si le premier est fini.

**Bloc 1 — débloquer et consolider**

1. **L3-16** — profils chauffeur par le canal interne (taille S)
2. **D30** — un chauffeur sans profil est renvoyé avec ses champs à `null`,
   jamais omis
3. **D31** — retirer `/rides/{id}/accept` et `/rides/{id}/reject` du contrat
4. **D32** — les appels sortants partent au commit, jamais pendant

**Bloc 2 — l'encaissement, partie mécanique**

5. **L4-05** — encaissement espèces, passage à `settled`
6. **L5-01** — compte courant chauffeur, journal des mouvements
7. **L5-02** — plafond d'encaisse bloquant

**Pas L5-03 à L5-07.** Remise de caisse, écriture comptable et écrans viendront
après. Ce lot-ci est la partie mécanique : un montant se déplace, un journal
l'enregistre, un seuil bloque.

## Bloc 1 — le détail

**D30 — le profil manquant.** Ta découverte était juste et sa gravité bien
évaluée : sans profil, aucune course ne pouvait aboutir. Mais la règle
elle-même était mauvaise, et elle l'était avant ton câblage. Un défaut de cache
ne doit jamais retirer un chauffeur de la flotte — c'est la même famille de
panne que le marqueur d'engagement resté en place.

Champs `firstName`, `photoUrl`, `rating`, `motorcycleClass` nullables dans
`NearbyDriverSchema`. Un chauffeur sans **position**, lui, reste écarté : sans
position il n'y a pas de distance. Ce qui est nécessaire au service reste
bloquant, ce qui n'orne que l'affichage ne l'est jamais.

**D31 — un seul chemin d'écriture.** Tu l'as signalé toi-même comme « à
trancher plus tard ». Je tranche maintenant : deux chemins qui coexistent trois
semaines finissent par avoir chacun leurs appelants, et c'est exactement ce qui
a produit D26.

**Ne supprime pas la preuve avec l'endpoint.** Les scénarios de L4-11 utilisent
`/accept` pour prouver le verrouillage d'Odoo, qui reste nécessaire — le service
temps réel écrit toujours ses transitions dans Odoo. Fais-les viser
`/api/internal/rides/{id}/driver-accepted`.

**D32 — l'appel qui part trop tôt.** `notify_cancellation_async` lance son fil
démon **pendant** la transaction. Le fil démon répond à la question de la
latence ; il ne répond pas du tout à celle de l'atomicité. Si la transaction
d'annulation échoue au commit — et le scénario 2 de L4-11 est exactement ce
cas — Redis a déjà été modifié pour une annulation qui n'a pas eu lieu, et le
chauffeur revient au pool avec une course vivante.

C'est D26 à travers la frontière des deux services. Dans une base, la
transaction protège de ça toute seule ; dès qu'un effet en sort, plus rien ne le
rattrape.

Point d'accroche au commit, pour tous les appels sortants — `clear_engagement`
depuis `_complete_ride` porte le même défaut en plus doux. **Sauf
`reserve_and_propose`**, qui précède délibérément la transition puisque c'est
son résultat qui l'autorise ; c'est pour ça que tu lui as construit son
idempotence.

Écris le test qui échoue d'abord : une transition dont la transaction échoue au
commit ne doit avoir modifié aucune clé Redis.

## Bloc 2 — la logique financière

**Deux paramètres ont été arbitrés, ils sont dans `01-architecture.md` §7.**

**D28 — plafond fixe pour toute la flotte**, paramétrable en back-office,
50 000 FCFA au départ. Pas de plafond par chauffeur.

**D29 — un écart de caisse reste au solde du chauffeur** et continue de peser
sur son plafond. La remise est acceptée pour ce qui est réellement remis. Le
logiciel enregistre un fait, il ne prend aucune décision de ressources
humaines. Ça concerne L5-06, hors de ce lot, mais L5-01 doit rendre ce
comportement possible : le solde doit pouvoir rester non nul après une remise.

**Ce lot est relu par un humain avant fusion** (`CLAUDE.md`). Écris-le comme
tel : chaque mouvement de compte courant tracé, chaque règle de calcul isolée
et testable seule, aucune valeur en dur.

**Et un avertissement qui vaut pour tout ce lot.** Partout ailleurs, un test
vert prouve que le comportement correspond à la spécification. Ici, il prouve
seulement qu'il correspond aux chiffres que j'ai écrits — et je me suis trompé
trois fois cette semaine, dont une sur un critère de concurrence que tu as
implémenté fidèlement. Si une règle financière te paraît étrange, arrête-toi et
écris-le. C'est le lot où le protocole d'écart compte le plus.

## Protocole — inchangé

Un commit par tâche, avec son entrée de rapport.

Cette session touche Odoo lourdement. `make reset` complet avant de déclarer
quoi que ce soit fini.

Lis les spécifications des tâches dépendantes : pour L5-01, lis L5-03 et L5-06.

Les fichiers d'écart vont dans `amoa/questions/<ID-TACHE>.md`, sur `master`.

**Si le bloc 2 ne passe pas en entier, arrête-toi proprement après le bloc 1.**
Un déblocage propre vaut mieux qu'un compte courant à moitié testé.

## Rapport

`amoa/rapport-nuit-J10.md`, une entrée par tâche, commitée avec elle.

## Ce que j'attendrai demain matin

Une course menée de bout en bout jusqu'à l'encaissement, avec un vrai chauffeur
visible dans la liste des cinq. Et un solde qui monte.
```

---

## Après cette nuit

Une course sera démontrable de bout en bout, encaissement compris — pour la première fois depuis le
début du projet.

Resteront : la remise de caisse et ses écrans (L5-03 à L5-07), la file de rejeu (L3-12) qui est le
dernier chemin sans filet, la seconde moitié du lot temps réel, puis les applications mobiles
elles-mêmes (lot L6), qui n'ont pas encore commencé.

Et toujours : **le compte Google Play.** Huit jours. Sans lui, rien de tout cela n'atteint un
téléphone.
