# Écart — le bouton d'urgence chauffeur n'a pas d'écran où vivre (24 août 2026)

Trouvé en implémentant L8-04, pas contourné en silence.

## Constaté

La spécification demande le bouton « depuis l'écran de course » pour le chauffeur comme pour le
client. Côté client, cet écran existe (`TrackingScreen.tsx`, L6-09) : le bouton y est monté ce
soir, testé, vérifié en navigateur. Côté chauffeur, il n'existe pas : `apps/driver/src/screens/`
ne contient que `SignInScreen.tsx`. L6-11 (bascule en ligne/hors ligne), L6-12 (réception de
proposition), L6-13 (course en cours, l'écran visé par L8-04) et L6-14 (confirmation
d'encaissement) n'ont jamais été construites — vérifié dans le dépôt (`git branch -a`, aucune
branche L6-11 à L6-14), pas supposé.

## Ce qui a été fait quand même

Le backend (`babana.incident`, `POST /rides/{id}/incidents`) est symétrique entre client et
chauffeur dès ce soir — `trigger_actor` distingue les deux, testé pour les deux
(`test_incident.py::test_driver_can_trigger_during_an_active_ride`). Le composant
`apps/driver/src/components/EmergencyButton.tsx` existe, testé en isolation (quatre tests,
`__tests__/EmergencyButton.test.tsx`), prêt à être monté le jour où L6-13 existera.

Une différence délibérée avec la version client : `getPosition` y est **injecté** plutôt
qu'obtenu via `@react-native-community/geolocation` en dur (le paquet n'est même pas une
dépendance de `apps/driver` aujourd'hui). Deux raisons : ne pas ajouter une dépendance de
géolocalisation à une app qui n'a encore aucun écran pour la déclencher (CLAUDE.md, « aucune
dépendance nouvelle sans nécessité »), et laisser à L6-13 le choix réel qui lui revient — rappeler
le GPS à l'instant, ou réutiliser la dernière position déjà en vol vers `position.update`
(L3-01/L3-02, l'app chauffeur en émet en continu pendant une course). Ce choix n'est pas anodin et
n'appartient pas à ce composant.

## Ce que ça ne permet pas de vérifier ce soir

Le critère d'acceptation 1 de L8-04 (« atteignable en un geste depuis l'écran de course ») **n'est
pas vérifiable côté chauffeur** — il n'y a pas d'écran. Ce n'est pas un défaut de L8-04 : c'est un
défaut de séquencement du lot Chauffeur, déjà connu (`amoa/questions/REPONSES-2026-08-29.md`,
« Ce qui reste ouvert » nomme le lot Chauffeur en général).

## Proposition

Quand L6-13 (course en cours, côté chauffeur) sera construite : monter `EmergencyButton` en lui
passant `getPosition` branché sur la dernière position connue du flux `position.update`
existant, pas un nouvel appel GPS. Aucune tâche dédiée à ouvrir pour ça — c'est une ligne de
câblage dans L6-13 elle-même, pas un lot séparé.
