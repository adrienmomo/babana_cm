# Arrêts multiples et facturation de l'attente — 17 novembre 2026

Séance de cadrage avec le maître d'ouvrage. Réponses données en séance ; les spécifications qui
en découlent sont L2-08, L4-14, L4-15 et L6-21 (rédigées à sa demande explicite, même jour).

## 1. Décision proposée — amende D15 et É9

> **Je propose D-suivant :** pas de prix à la minute **de trajet** (D15 maintenue sur ce point).
> L'**attente** est facturée, mesurée uniquement à partir d'événements du chauffeur — jamais
> d'une trace GPS envoyée à Odoo. Chaque arrêt ajoute un **forfait par arrêt** au prix de
> distance. Le prix de distance reste celui de l'itinéraire prévu tant que la distance mesurée
> reste dans une bande paramétrable autour de la distance prévue ; hors de cette bande, il est
> recalculé sur la distance mesurée.

**Approuvée sur le fond le 17 novembre ; numéro à attribuer au débrief.**

**Pourquoi D15 ne s'y oppose pas.** É9 retire le terme temps parce que la seule durée connue
avant la course est une durée *voiture* (É8), qui surfacture la moto aux heures de pointe. Une
attente n'est pas estimée : elle est mesurée entre deux événements déclarés. L'objection d'É9
ne s'y applique pas. En revanche, « prix ferme calculé sur le devis » ne tient plus en entier :
le prix de distance reste ferme dans la bande, l'attente s'ajoute à la fin.

**Invariant 1.** Les écritures restent bornées par les décisions : ajout d'arrêt, arrivée à un
arrêt, départ d'un arrêt, début d'un arrêt imprévu — une écriture chacun. Aucun compteur
d'attente n'est écrit ; le montant se calcule une fois, à `action_complete`, à partir des
horodatages.

## 2. Réponses du maître d'ouvrage

| # | Question | Réponse |
|---|---|---|
| 1 | Début d'une attente imprévue (course sans arrêt prévu) | Bouton chauffeur « Arrêt client » |
| 2 | Fin d'une attente | **Automatique dès que la moto repart**, bouton « Repartir » en secours |
| 3 | Arrivée à un arrêt prévu | Automatique dans un rayon de N m, bouton « Arrivé » en secours |
| 4 | Client informé de l'attente pendant la course | **Non.** Ni notification, ni compteur. L'attente apparaît seulement sur le reçu, ligne à part |
| 5 | Arrondi | Minutes **complètes** seulement (2 min 59 s facturables → 2 min) |
| 6 | Tarif d'attente | Un seul tarif par minute (30 F), prise en charge et arrêts confondus. Gratuité : 3 min à la prise en charge, 2 min aux arrêts |
| 7 | Forfait par arrêt | 100 F par arrêt, ajouté au prix de distance, paramétrable dans Odoo |
| 8 | Arrêt ajouté pendant la course | Le client confirme le nouveau prix ; le chauffeur est notifié et **ne peut pas refuser** |
| 9 | Distance du prix final | Prix prévu si distance mesurée ∈ [60 %, 100 %] de la distance prévue ; sinon même formule sur la distance mesurée, coefficients gelés au devis. Bornes paramétrables |
| 10 | Distance mesurée absente | Prix prévu, course signalée au back-office |
| 11 | Limites | 3 arrêts au plus ; attente facturable plafonnée à 15 min par point. Paramétrables |

Tous les montants, durées, seuils et rayons ci-dessus sont des **valeurs initiales** de
paramètres (invariant 5), jamais des constantes.

## 3. Points laissés ouverts — à trancher avant ou pendant L4-15

**3.1 Au-delà de 100 %, le client paie le détour du chauffeur.** La règle 9 recalcule aussi vers
le haut. Un chauffeur qui se perd, ou qui suit un tracé plus long que l'itinéraire voiture, fait
payer le client. Les chauffeurs étant salariés (D5), l'incitation à gonfler est faible ; mais le
client, lui, ne voit le montant qu'à l'arrivée. Options : (a) garder la règle telle quelle ;
(b) plafonner la hausse (par exemple +20 % du prix prévu) ; (c) ne recalculer vers le haut que
sur décision d'un superviseur. **Spécifié selon (a)**, bornes paramétrables, en attendant.

**3.2 Client absent après attente.** Une annulation « client absent » (`NO_SHOW_GRACE`, 5 min
après « Sur place ») intervient après 2 minutes facturables. Factures-t-on cette attente ?
Aujourd'hui une annulation n'encaisse rien. **Spécifié : non**, l'attente n'est facturée que
sur une course terminée.

**3.3 Heure de l'événement hors connexion.** La campagne de résilience (A3) montre un « Sur
place » enregistré 17 s après le retour du réseau. Si l'attente se mesurait à l'heure de
réception par Odoo, une coupure allongerait ou raccourcirait la facture. **Spécifié :**
l'événement porte l'heure du téléphone, bornée par le serveur à
[événement précédent, heure de réception]. Le décalage d'horloge des terminaux reste un risque
connu (cf. émulateurs).

**3.4 L'attente à la prise en charge et D81.** D81 facture l'approche à l'estimation. L'attente
à la prise en charge s'y ajoute sans la modifier — à confirmer.

## 4. Tâches créées

| Tâche | Objet | Dépend de |
|---|---|---|
| L2-08 | Paramètres d'arrêt et d'attente, cotation multi-arrêts | L2-04 |
| L4-14 | Arrêts de course : modèle, événements, ajout en cours de course | L2-08, L4-02 |
| L4-15 | Prix final : bande de distance, forfaits, attente | L4-14 |
| L6-21 | Apps : saisie des arrêts, détection arrivée/départ, reçu détaillé | L4-14, L4-15 |
| L4-16 | Enregistrement du trajet pour la sécurité, rejeu, avis au client | L4-14, L3-19, L8-02 |

Contrats touchés : C-01 (requêtes et réponses), C-02 (message `ride.stop.added` au chauffeur),
C-03 (événements d'arrêt — ce ne sont **pas** des transitions d'état ; la course reste
`in_progress`). À inscrire au §4 de `03-decoupage-taches.md` au débrief.

## 5. Rejeu des prix et enregistrement des trajets — même séance

**Rejeu du prix (L2-03 : « rejouer un litige tarifaire à l'identique six mois plus tard »).**
Trois trous relevés dans la première rédaction, corrigés dans L4-14 et L4-15 :
(1) le prix final n'était pas déclaré fonction pure ; (2) une cotation en cours de course ne
précisait pas quelle version de grille elle utilise, et écrasait la précédente ; (3) l'heure
bornée d'un événement dépendait de l'heure de réception, non conservée. Désormais : fonction
pure, grille gelée au premier devis, chaque cotation confirmée conservée, heure bornée stockée.

**Enregistrement des trajets** — exigence de sécurité du maître d'ouvrage : chaque trajet est
conservé et rejouable pendant un an ; le client en est informé à chaque démarrage.

| Question | Réponse |
|---|---|
| Garantir la trace si le temps réel redémarre | Copie locale sur le téléphone du chauffeur, téléversée une fois à la fin |
| Périmètre | Trajet seulement (démarrage → arrivée) |
| Conservation | 1 an (paramètre), puis suppression ; sauf incident ou contestation ouverts |
| Accès | Superviseurs et au-dessus, chaque consultation journalisée |

> **Je propose D-suivant (bis) :** la trace horodatée de chaque trajet est conservée un an,
> en une écriture par course, rejouable par les superviseurs sous audit ; le client en est
> informé à chaque démarrage. Tranche, pour les trajets, le point « conservation des données
> de localisation » du §11.

Point à vérifier hors du code : conformité à la loi camerounaise n° 2024/017 sur la protection
des données personnelles (finalité, durée, information, éventuelle déclaration à l'autorité).

## 6. Avis d'enregistrement au démarrage : push ou pas ? — contradiction relevée pendant L4-16

La réponse du 17 novembre demande que le client soit « notifié au démarrage de chaque course que
le trajet est enregistré pour sa sécurité ». La décision du 15 novembre (rapport du 15, réponse
« 1 Push ») limite les push client à **chauffeur affecté, arrivé, course terminée** — et
`test_client_push.py::test_starting_the_ride_sends_nothing` la protège.

Implémenté en attendant l'arbitrage : l'avis part avec `ride.started` et s'affiche sur l'écran de
suivi, **sans push**. Un client dont l'app est fermée au démarrage ne le voit donc pas à ce
moment-là.

Options : (a) garder ainsi — l'avis figure aussi dans les conditions d'utilisation ; (b) ajouter
le démarrage à la liste des push client (un push de plus par course) et modifier le test du
15 novembre en conséquence. Je recommande (b) : un client qui roule a rarement l'app au premier
plan, et c'est précisément lui que l'avis concerne.

**Arbitré le 17 novembre (maître d'ouvrage) : option (a), pas de push au démarrage.** La décision
du 15 novembre reste entière (push client : affecté, arrivé, terminé). L'avis d'enregistrement
passe par `ride.started` et l'écran de suivi, et figure dans les conditions d'utilisation.
