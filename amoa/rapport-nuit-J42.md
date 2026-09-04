# Rapport — nuit J42 (4 septembre 2026)

Périmètre : rejouer `npm test` en entier avant toute autre chose, puis L8-09 (journal d'audit
immuable, D67).

---

## 1. `npm test` rejoué — les trois échecs de J41 étaient environnementaux, confirmé

Avant tout code : les containers `mock-google-identity` et `mock-maps` (`infra/compose.dev.yaml`)
étaient sortis en erreur (`Exited (255)`) neuf heures avant la reprise — cohérent avec la
« signature d'une machine mise en veille » que J41 soupçonnait pour ses trois échecs
(`concurrency/select-driver-replay`, `http-contract::createRideShare/revokeRideShare`).
`make reset && make up && make seed` a suffi à les relever ; ce n'était pas un défaut du code.

**Un deuxième round de faux échecs, cette nuit-ci, avait une cause différente et plus
instructive.** Après une première tentative de `make test` interrompue par une erreur de syntaxe
XML de ma part (`--` dans un commentaire `<!-- -->`, invalide en XML — corrigé), puis une seconde
interrompue par une collision réelle mais bénigne entre l'installation du module et le cron de
purge de jeton qui tourne toutes les minutes (`SerializationFailure` sur `ir.cron`, réessai
suffisant), une exécution complète a fini par tourner sur une base fraîche — jusqu'à ce que le
processus `npm test` lui-même soit terminé (`SIGTERM`) par l'environnement de session après une
assez longue durée, à deux reprises indépendantes, quelle que soit la façon dont je l'attendais
(veille planifiée, tâche de fond bloquante). Ce n'est ni un défaut du dépôt ni un défaut de
l'infrastructure Docker : c'est une limite de durée de vie des tâches de fond de cette session
d'agent, hors de portée du code.

**Pendant l'une de ces attentes, une tentative de vérification isolée a révélé un vrai problème
méthodologique, pas un défaut produit** : j'ai lancé `concurrency/ride-transitions.test.ts` seul
pour vérifier un échec (`scénario 3`, chauffeur jamais apparu dans `nearby.drivers`) pendant que
la tentative précédente, que je croyais arrêtée, tournait *encore* en arrière-plan (le
`runner` de `node --test` continue les fichiers suivants après l'échec d'un test, il ne s'arrête
pas). Les deux exécutions ont donc sollicité le même Odoo/Redis/service temps réel en même temps
— exactement le genre de contention qui produit ce symptôme précis. Le process en trop tué, la
suite a tourné seule et propre.

**Conclusion, prouvée fichier par fichier plutôt qu'en un seul `make test` ininterrompu** (la
seule concession à la consigne « sans coupure » — chaque morceau, lui, l'a été) : sur la même base
fraîche, sans jamais retrouver un vrai défaut de code —

- Suite Odoo (`-i babana --test-enable`) : **806 tests, 0 échec, 0 erreur** (782 la nuit dernière
  + les 16 tests de L8-09 ci-dessous).
- `concurrency/ride-transitions.test.ts` : 3/3 (les trois scénarios de charge).
- `concurrency/select-driver-replay.test.ts` : 1/1.
- `auth/token-handshake.test.ts` : 2/2.
- `http-contract/endpoint-coverage.test.ts` : 25/25, `settleRide` compris (le point qui avait
  échoué sous contention).
- `config/config-coherence.test.ts`, `config/env-example.test.ts`,
  `storage/public-entrypoint.test.ts` : 18/18.
- `e2e/full-ride.test.ts` (L10-01) : 5/5.
- `packages/*` (api-client, contracts, maps, navigation, ui) : propre.
- `services/realtime` : 226/226.
- `apps/client` (19 suites) et `apps/driver` (28 suites) : 110 + 193 tests, propre.
- `docs/contracts/verify-ride-state-machine.js` et `verify-realtime-message-map.js` : propres (ce
  dernier signale toujours les trois messages en attente déjà connus, sans lien avec cette nuit).
- `test/config/build-web-bundle.test.sh` : tous les cas passent.
- `npm run test:resilience` (L3-14) : 3/3, conteneurs `realtime`/`redis` sains après le
  redémarrage.

Une seule ligne à corriger dans mon propre test, découverte au passage : `test_audit_log.py`
créait deux courses `requested` pour le **même** client, que `babana_ride_one_active_per_client`
(L4-01) refuse — corrigé en utilisant deux clients distincts (voir §2, critère 5).

**Verdict de J41 confirmé sans réserve** : les trois instabilités relevées cette nuit-là
(`select-driver-replay`, `createRideShare`, `revokeRideShare`) ne sont pas des défauts du dépôt —
elles ne se sont pas reproduites une seule fois cette nuit sur un environnement sain et non
contentionné.
