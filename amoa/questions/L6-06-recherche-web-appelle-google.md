# Écart — recherche de lieu, export web (23 août 2026)

Trouvé en vérifiant L3-19 dans un navigateur (montage jetable, `verify.localhost`), pas dans le
périmètre de cette tâche — consigné plutôt que corrigé à la volée sur du code hors périmètre,
conformément au protocole.

## Constaté

Sur l'export web (`apps/client`, `npm run build:web`), `PlacePicker` (`HomeScreen`) appelle
`https://maps.googleapis.com/maps/api/place/textsearch/json` au lieu de `mock-maps`
(`BABANA_MAPS_SEARCH_URL=http://localhost:4001/search`), malgré :

- la variable d'environnement correctement injectée au build (vérifié : la chaîne littérale
  `"http://localhost:4001/search"` est bien présente dans `dist-web/bundle.js`, comme valeur de
  `MAPS_SEARCH_URL`) ;
- `bootstrap()` (`apps/client/src/bootstrap.ts`) qui appelle bien
  `configureMapsProvider({ apiKey: GOOGLE_MAPS_API_KEY, searchUrl: MAPS_SEARCH_URL })`, et qui est
  bien invoqué en tête du premier `useEffect` de `useSession()`
  (`apps/client/src/navigation/index.tsx`), avant tout rendu d'écran susceptible d'appeler
  `searchPlace`.

Résultat : l'appel réel part vers Google (503 depuis ce poste, sans clé), la recherche échoue,
et l'écran d'accueil reste bloqué sans point de départ saisissable par ce chemin.

## Pas allé plus loin

Cause non identifiée avec certitude — candidats non vérifiés : double instanciation du module
`@babana/maps` dans le bundle webpack (deux fermetures de `providers/google/config.ts`, l'une
configurée, l'autre lue), ou un problème d'ordre entre `bootstrap()` et le premier rendu de
`PlacePicker` malgré l'analyse ci-dessus. Hors du périmètre de cette nuit (L3-19/C-02R/L3-18) ;
creuser cela aurait été improviser sur du code que la consigne ne nommait pas.

## Contourné pour vérifier L3-19 quand même

Le point de départ/arrivée et la sélection du chauffeur ont été produits directement par l'API
réelle (`POST /quote`, `POST /rides`, `POST /rides/{id}/select-driver`) depuis un script, avec la
même session client que celle injectée dans le navigateur — un abonné réel restait donc connecté
côté navigateur pendant que le reste du cycle (acceptation réelle par un chauffeur scripté,
`POST /start`, `POST /complete`, tous réels, tous 200) se déroulait. Voir
`amoa/rapport-nuit-J19.md`, §L3-19, pour ce que cela prouve et ce que cela ne prouve pas :
`ride.started`/`ride.completed` ont été poussés par le vrai service temps réel à la vraie
connexion WebSocket de ce navigateur, mais je n'ai pas pu confirmer visuellement leur réception
côté interface (`TrackingScreen`/`RideSummaryScreen` jamais atteints, faute de pouvoir saisir un
point de départ) — seule la preuve serveur (deux réponses HTTP 200 réelles) a été obtenue en
direct.

## Proposition

Une tâche dédiée à ce défaut avant la prochaine vérification navigateur complète — sans elle,
aucun parcours réel ne peut plus être suivi jusqu'au bout sur l'export web, quelle que soit la
tâche du soir.
