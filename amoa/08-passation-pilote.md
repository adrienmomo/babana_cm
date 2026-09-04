# Passation vers le pilote

**Écrit le 19 septembre 2026**, au terme du développement du périmètre pilote (J43 excepté).

Ce document n'est pas une documentation. C'est la liste de ce qu'il reste à faire, dans l'ordre,
pour arriver aux premières vraies courses — et de ce qu'il faut regarder une fois qu'elles
roulent.

---

## 0. Ce document attend, et il est écrit pour ça

**Mis à jour le 24 septembre 2026.** Le développement est terminé — aucun défaut ouvert, suite complète verte sur base neuve — et la suite ne dépend plus que de démarches qui vous appartiennent. D'autres priorités passent avant, et c'est légitime : rien ici ne se périme la semaine prochaine.

Ce document est donc fait pour être repris froid, dans un mois ou dans trois, sans avoir à relire quarante-sept rapports de nuit. Reprenez-le au §2.

**Ce qui ne vieillit pas.** Le code, les spécifications, les décisions, les tests. Le dépôt est cohérent, la suite est verte, et `make up` donne une course complète parcourable sans aucun compte externe. Rien ne se dégrade tout seul.

**Ce qui vieillit, en revanche, et qu'il faut savoir avant de reprendre :**

| Ce qui bouge sans vous | Conséquence au retour |
|---|---|
| Les images Docker et les dépendances npm | Un premier `make up` après plusieurs mois peut demander une mise à jour. Rien de grave, mais ce n'est pas le soir de la démonstration qu'il faut le découvrir |
| Les consoles Google Cloud et Firebase | Les écrans et les noms d'API changent ; les procédures que vous trouverez en ligne seront à jour, celles décrites ici peut-être pas |
| La vérification d'éditeur Android | Elle a ses propres échéances, indépendantes de nous |
| Ce que votre client a en tête | C'est celui qui vieillit le plus vite. Il attend une démonstration depuis un moment, et elle ne coûte qu'un VPS et quatre noms DNS — c'est la seule ligne de ce document qui gagne à être faite tôt, même si tout le reste attend |

**Et une chose à faire au retour, avant toute autre :** `make reset && make up && make seed && make test`, en entier, sur une base réellement vidée. C'est le geste qui a révélé trois défauts d'installation en septembre — dont un compte administrateur sans droits — et c'est aussi celui qui vous dira, en une commande, si quelque chose a bougé sous le dépôt pendant l'attente.

**Le document à lire ensuite, si une session de développement reprend** : la passe de clôture de `amoa/rapport-nuit-J41.md`, tenue à jour jusqu'à la dernière nuit. Elle dit ce qui est rouge, ce qui est vert sans avoir jamais été exercé pour de vrai, et ce qui a été supposé. C'est le document le plus utile du dépôt.

---

## 1. Ce qui est fait, en une phrase

Une course complète est parcourable de bout en bout : un client demande, choisit un chauffeur,
suit son trajet, paie en espèces ; le chauffeur reçoit, accepte, encaisse, remet sa caisse ; un
superviseur valide les dossiers, arbitre les écarts, consulte un journal d'audit immuable. Le tout
sans aucun compte externe, en simulé, dès le premier `make up`.

**123 tâches spécifiées, le périmètre pilote livré.** Ce qui reste hors périmètre est de la
calibration — elle a besoin des données du pilote pour être juste.

---

## 2. Les six démarches, et rien n'attend rien

Aucune de ces lignes ne dépend d'une autre. Elles peuvent toutes partir la même semaine, et c'est
ce que je recommande : la plus longue commande la date.

| Démarche | Ce qu'elle débloque | Latence propre |
|---|---|---|
| **Relais SMTP** | Le déploiement réel — `deploy.sh` refuse de partir sans | **La plus longue** : souscription immédiate, vérification du domaine (SPF, DKIM) plusieurs jours |
| **Compte Google Cloud** | Le déploiement réel — identité, routage, Maps | Des heures, carte bancaire requise |
| **VPS + DNS** | La démonstration d'abord, le déploiement ensuite | Des heures |
| **Restauration sur hôte vierge** | L8-08, qui n'est pas finie sans | Une soirée |
| **Une demi-journée avec un téléphone** | L6-19 — sans le sélecteur de pièces, **aucun chauffeur ne peut s'inscrire** | Une demi-journée |
| **Validation du plan comptable** | Rien techniquement — mais les factures partent avec des comptes provisoires | Votre comptable |

**Le DNS demande quatre noms** : l'apex `babana.cm`, `api.`, `admin.`, et `storage.` (la route du
stockage des documents, ajoutée le 17 septembre). Prévoyez-les en une fois.

---

## 3. L'ordre, si vous voulez une seule séquence

**Aujourd'hui.** Lancer le relais SMTP et le compte Google Cloud — ce sont les deux qui attendent
sans vous. Le SMTP d'abord : c'est lui qui commande la date.

**Cette semaine.** Provisionner le VPS, pointer les quatre noms, et faire la démonstration au
client — elle tourne en simulé, fermée par `WEB_ALLOWED_IPS`, sans aucun compte externe. Le
déroulé est dans `amoa/07-demonstration.md`.

**Dès qu'un téléphone est disponible.** La demi-journée L6-19. Elle est bloquante pour de vrais
chauffeurs, et elle porte aussi la mesure de batterie, qui décide d'un réglage qu'on ne peut pas
deviner.

**Quand les deux comptes existent.** Le déploiement réel, en suivant `code/docs/operations/production.md` —
dix étapes, la frontière machine y est explicite. Puis la restauration sur hôte vierge, qui clôt
L8-08.

**Avant d'ouvrir à de vrais chauffeurs.** La liste du §4.

---

## 4. Ce qu'il faut vérifier avant les premières vraies courses

Six points. Aucun n'est théorique — chacun correspond à une chose que ce projet a découverte en
l'essayant plutôt qu'en la lisant.

1. **Le mot de passe administrateur a été changé**, et `list_db` est resté désactivé.
2. **`admin.babana.cm` renvoie 403 depuis une adresse hors liste** — le seul critère du contrôle
   de mise en production qui se teste depuis une autre machine que le serveur.
3. **Un email de facture est réellement arrivé** dans une vraie boîte, pas dans un simulateur.
   Aucun email n'a jamais quitté ce projet ; le relais réel a ses propres limites et son propre
   silence.
4. **Le bouton « Voir la pièce » affiche un document depuis un navigateur ordinaire**, hors du
   réseau du serveur. C'est le geste qui approuve un chauffeur, et il a été cassé jusqu'au
   17 septembre sans qu'aucun test ne le voie.
5. **Une sauvegarde a été restaurée sur un hôte vierge**, avec la ligne écrite dans le journal de
   `code/docs/operations/production.md` §7.
6. **La supervision alerte réellement**, vérifié en provoquant une panne — pas en lisant la
   configuration.

---

## 5. Les trois chiffres à relever dès le premier jour

Un pilote existe pour produire des chiffres, pas pour confirmer des intuitions. Ces trois-là
décident chacun d'une tâche différée, et aucun ne se reconstitue après coup.

**Combien de courses échouent faute de pouvoir joindre le passager.** C'est le coût réel de la
décision de démarrer sans OTP (D66). S'il est nul, la passerelle SMS est une commodité ; s'il est
significatif, L1-09 devient urgente et elle est déjà spécifiée.

**Combien de temps tient la batterie d'un chauffeur.** Tous les réglages de capture sont
paramétrables exprès : si elle ne tient pas, la réponse est un changement de valeurs le soir même,
jamais une réécriture. Mesuré le premier jour, sur deux ou trois terminaux — pas quand on y
pensera. Un chauffeur qui désinstalle au bout d'une semaine ne revient pas, et personne ne saura
pourquoi.

**L'écart entre l'ETA affiché et la durée réelle.** Ni Google ni Mapbox ne calculent d'itinéraire
deux-roues au Cameroun : tout passe par un modèle voiture corrigé par un facteur. Ce facteur est
une hypothèse jusqu'à ce que de vraies courses le mesurent.

---

## 6. Ce qui est vert mais que personne n'a jamais exercé pour de vrai

La liste complète est dans `amoa/rapport-nuit-J41.md`, section de clôture — c'est le document le
plus utile du dépôt et il mérite une lecture entière. Les quatre qui vous concernent directement :

- **`bootstrap.sh` n'a jamais été lancé.** Il durcit un hôte réel et n'a de sens que là. C'est le
  script du tout premier soir, et c'est le moment où une surprise reste possible.
- **`rollback.sh` non plus** — il annule un déploiement précédent, qu'aucune nuit n'a produit.
- **Les notifications push n'ont jamais rencontré un vrai compte Firebase.** Le chemin est câblé
  et testé contre un simulateur ; le journal est le seul chemin réellement emprunté à ce jour.
- **Aucun email n'a jamais atteint une vraie boîte.**

---

## 7. Ce qui reste ouvert, et que j'assume par écrit

**Aucune intégration continue.** Le protocole affirme qu'elle est bloquante ; elle n'existe pas.
Les nuits ont lancé la suite complète à la main, consciencieusement, et c'est la seule raison pour
laquelle ça n'a rien coûté. **Cette décision devient fausse le jour où quelqu'un d'autre touche au
dépôt** — c'est la première chose à faire ce jour-là, avec la détection d'instabilité.

**Un test instable sans théorie.** Vu une fois le 15 septembre, jamais reproduit, jamais corrigé.

**Les comptes comptables sont plausibles et non validés.** Les factures partent automatiquement
depuis le 15 septembre, avec ces libellés.

**Deux champs-pont vivent encore** — la note moyenne du chauffeur et le code promotionnel —
chacun attendant une tâche hors périmètre. Ils sont tracés dans `code/docs/bridge-fields.md`.

---

## 8. Quand les nuits reprennent

Quand le terrain aura parlé. La calibration — ETA, seuils de dispatch, tarifs réels — a besoin des
données du pilote pour être juste, et la faire avant reviendrait à deviner, puis à défaire.

Le premier lot d'après-pilote se composera tout seul à partir des trois chiffres du §5.
