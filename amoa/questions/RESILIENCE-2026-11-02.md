# Campagne de résilience réseau, course par course (31 octobre – 2 novembre)

Une course complète sur les deux émulateurs, en coupant le réseau du client ou du chauffeur à
chaque étape. **Méthode** : les paquets vers Odoo (8069) et le service temps réel (3000, 4001)
sont jetés sur le téléphone (`iptables DROP`) pendant 15 à 60 s, puis rétablis — une perte de
données silencieuse, comme sur un réseau mobile qui garde le signal sans faire passer de données.
(Couper le transfert de ports adb ne coupait rien : la connexion déjà ouverte survivait.)

## Résultats par étape

| Étape | Coupure | Résultat |
|---|---|---|
| A1 Approche | client 40 s | ✅ position du chauffeur à jour au retour |
| A2 Approche | chauffeur 40 s en roulant | ✅ position rattrapée ; bandeau « Connexion perdue » côté client |
| A3 « Sur place » | chauffeur, glissé hors ligne | ⚠️ aucune indication pendant la coupure ; enregistré ~17 s après le retour du réseau |
| B1 Démarrage | client pendant « Commencer » | ✅ « Course en cours » au retour |
| B2 Trajet | chauffeur 60 s en roulant (~1 km) | ✅ point suivant accepté (≈ 17 m/s < 38,9), trajet mesuré 3,1 km |
| B3 Fin de course | client pendant « Terminer » | ✅ résumé de fin affiché au retour |
| C1 Encaissement | chauffeur, confirmé hors ligne | ⚠️ « Confirmation… » sans explication ; enregistré 32 s après le retour |
| D1 Note | client, envoyée hors ligne | ✅ une seule note (deux envois, même clé) — chronologie faussée par une mise en veille de l'hôte |
| P2 Proposition | chauffeur 15 s pendant la proposition | ❌ **jamais affichée** : expirée, « Ce chauffeur n'a pas répondu » |
| Redémarrage | app client relancée pendant l'attente | ✅ retour sur l'écran d'attente de la course ouverte |

## Défauts

**1. Le téléphone ne détecte pas une connexion temps réel morte (P2, A3, C1).** Le serveur a un
battement de cœur (`ws/liveness.ts`, 30 s) ; le téléphone n'en a aucun. Après une coupure
silencieuse, l'app garde sa vieille connexion et se croit connectée (« Connexion au service
établie » affiché tout du long) : elle ne se reconnecte pas, ne demande pas la resynchronisation,
et un message envoyé pendant la coupure — la proposition — est perdu. Le chauffeur ne voit jamais
une course qui lui était proposée.

**2. Une requête HTTP envoyée pendant une coupure attend en silence (A3, C1).** Aucun délai
maximal côté app : la requête reste en vol sur la connexion morte, réémise par TCP de plus en plus
espacée, et n'aboutit que 17 à 32 s après le retour du réseau. Rien n'est perdu, mais le
chauffeur ne sait pas que son geste n'est pas encore passé.

**3. Horloge : mon correctif du 31 octobre ne se met pas à jour sur une connexion calme.**
L'écart entre l'horloge du téléphone et celle du serveur n'est appris que des messages reçus ;
un chauffeur en ligne sans course n'en reçoit aucun. Si l'heure du téléphone change pendant la
session (mise à l'heure automatique ; ici, émulateurs figés pendant la veille de l'hôte), toutes
ses positions sont rejetées comme anciennes et il disparaît du vivier sans le savoir. Reproduit le
2 novembre ; une relance de l'app le corrige.

**4. Corrigé le 2 novembre : bandeau « Position non mise à jour depuis 0 s » figé côté client.**
Après un premier silence, le réabonnement remplaçait la surveillance sans lever le silence
affiché : le bandeau restait pour toute la course. Et l'âge affiché comparait l'heure du serveur à
celle du téléphone (« 0 s » ou « 57 600 s » selon le sens du décalage). Corrigé avec ses tests.

## Proposition

Un **battement de cœur applicatif** traite 1 et 3 d'un seul geste : l'app envoie un `ping`
toutes les N secondes, le serveur répond `pong` ; sans réponse sous M secondes, l'app ferme la
connexion et se reconnecte — donc se resynchronise (`session.synced` porte la proposition en cours).
Chaque `pong`, daté par le serveur, remet aussi l'horloge à jour. Coût : un petit message toutes
les N secondes (N = 20 : ~3 Ko/h). Ajout au contrat C-02 (deux types de messages).

Pour 2 : un délai maximal sur les requêtes HTTP de l'app (15 s par exemple), puis l'action passe
par la file hors connexion existante quand elle y a droit (encaissement, note), ou affiche
« Pas de réseau — réessayez » (« Sur place », dont l'heure fait foi et ne se rejoue pas).

Je propose D-suivant : battement de cœur applicatif entre les apps et le service temps réel
(`ping`/`pong`, C-02), cadence et délai réglables ; et délai maximal sur les requêtes HTTP des
apps.

## Observation

Côté chauffeur, « Urgence — Position indisponible — réessayez » s'affiche en permanence sous le
bouton, y compris en ligne avec une position fraîche. Non examiné.
