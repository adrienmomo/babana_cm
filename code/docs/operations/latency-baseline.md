# Latence de référence depuis Douala (L0-07, étape 9)

**Statut : NON MESURÉE.** Se mesure depuis une vraie connexion camerounaise (pas un poste
européen, pas un datacenter), à la mise en service, avant l'ouverture au pilote. Sans cette
valeur, toute dégradation ultérieure est invérifiable et se discutera à l'impression.

## Méthode

Depuis un terminal à Douala, sur une connexion représentative de celle d'un chauffeur (data
mobile d'entrée de gamme, pas la fibre d'un bureau) :

1. **API HTTP** — 100 requêtes `GET https://api.babana.cm/web/health`, espacées d'une seconde.
   Relever min / médiane / **p95** / max du temps total (`curl -w '%{time_total}'`).
2. **WebSocket** — établir `wss://api.babana.cm/rt/ws?token=<jeton de test>` 20 fois, relever le
   temps jusqu'au handshake abouti (min / médiane / p95).
3. **Aller-retour applicatif** — 30 `POST /api/v1/quote` avec un couple de points fixe et un
   jeton de test, relever min / médiane / p95. C'est la mesure la plus proche de l'expérience
   réelle (Odoo ↔ PostgreSQL plusieurs fois par appel).
4. Répéter les trois à **trois moments** de la journée (creux, midi, soir) — l'hôte est partagé
   (D18), la charge du voisinage varie.

Script de collecte : à ajouter à `infra/production/monitoring/` le jour de la mesure (il n'a de
sens qu'exécuté depuis Douala).

## Relevé

| Date/heure | Connexion | API p50 | API p95 | WS p50 | WS p95 | /quote p50 | /quote p95 |
|---|---|---|---|---|---|---|---|
| _(creux)_ | | | | | | | |
| _(midi)_ | | | | | | | |
| _(soir)_ | | | | | | | |

**Référence retenue** (p95 le plus défavorable des trois relevés) :

- API : _____ ms
- WebSocket : _____ ms
- `/quote` : _____ ms
- Mesurée le _____ par _____

## Seuil de bascule d'hébergeur

Défini à partir de la référence ci-dessus — voir `docs/operations/production.md`, section
« Seuil de bascule d'hébergeur ». À écrire et dater **avant** la mise en service.
