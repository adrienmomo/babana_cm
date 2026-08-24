# Écart — la notification du contact d'urgence est journalisée, pas envoyée (24 août 2026)

Trouvé en implémentant L8-04, pas contourné en silence.

## Constaté

Le critère d'acceptation 4 de L8-04 demande : « Le contact d'urgence est notifié s'il est
renseigné ». `res.partner.babana_emergency_contact` (L1-04) est un numéro de téléphone. Aucun
relais SMS n'existe dans ce dépôt -- ni service simulé (`services/mocks/`), ni configuration
externe (`infra/env/.env.example`), à la différence de Google Sign-In (D19, mock-google-identity)
ou de la cartographie (mock-maps). Le seul canal de notification déjà câblé est le SMTP de
développement (mailpit), qui n'a pas de destinataire pertinent ici -- un contact d'urgence est un
numéro, jamais une adresse email.

## Ce qui a été fait

`babana.incident._notify_emergency_contact()` (`models/babana_incident.py`) enregistre l'intention
: le numéro est copié sur l'incident (`emergency_contact_phone`, figé au déclenchement -- une
correction ultérieure de la fiche client ne doit pas réécrire l'histoire d'un incident déjà
traité), `emergency_contact_notified` passe à vrai, et un `_logger.warning` explicite journalise
ce qui *aurait* dû partir. Aucun SMS n'est réellement envoyé -- `emergency_contact_notified` ne
certifie donc que l'enregistrement de l'intention, jamais la livraison.

**Pourquoi ne pas avoir simulé un envoi comme les autres fournisseurs (D19/D43)** : les mocks déjà
en place (Google, cartographie) ont un point d'intégration concret côté vraie API -- un JWKS, un
`Places Text Search` -- que le mock imite fidèlement. Un relais SMS a un point d'intégration
téléphonique entier (D42 le nomme déjà ainsi pour le masquage de numéro : « une intégration
téléphonique entière »), avec un choix de fournisseur (Twilio, Africa's Talking, un agrégateur
local camerounais) qui n'a jamais été arbitré. Inventer un mock pour un fournisseur non choisi
aurait posé une fausse évidence -- exactement ce que D43 met en garde contre (« une configuration
qui retombe sur le vrai fournisseur masque sa propre panne »), ici inversé : un mock sans
fournisseur réel désigné masquerait l'absence de choix, pas une panne.

## Conséquence pour un client réel

**Doute assumé, pas caché.** Tant que ce relais n'existe pas, le proche désigné par un client ne
reçoit jamais réellement de SMS lors d'un déclenchement d'urgence -- seul le back-office voit
l'incident (critères 1, 2, 3, 5, 6 de L8-04 sont, eux, pleinement fonctionnels et testés). C'est la
limite la plus sérieuse de ce lot.

## Proposition

Une tâche dédiée, au même rang que D42 (masquage/relais téléphonique) : choisir un fournisseur
SMS, l'arbitrer comme une décision d'architecture (D-quelque-chose), lui donner un mock (D19) et
une configuration explicite sans repli vers le vrai fournisseur (D43). `_notify_emergency_contact`
est écrit pour que cette tâche n'ait qu'à remplacer le corps de la méthode -- la donnée
(`emergency_contact_phone`, figée au bon moment) est déjà en place.
