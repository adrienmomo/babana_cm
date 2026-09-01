COMPOSE = docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env

.PHONY: up down logs reset seed seed-drivers client driver test lint typecheck verify secrets-scan

up:              ## Démarre tous les services et attend qu'ils soient sains
	@test -f infra/env/.env || cp infra/env/.env.example infra/env/.env
	$(COMPOSE) up -d --build --wait --wait-timeout 180
	$(COMPOSE) exec -T minio sh /bootstrap.sh
	@echo "Odoo         http://localhost:8069"
	@echo "API          https://api.localhost"
	@echo "Back-office  https://admin.localhost"
	@echo "Partage      https://localhost/s/<token>"
	@echo "MinIO        http://localhost:9001"
	@echo "Mailpit      http://localhost:8025"

down:            ## Arrête tout
	$(COMPOSE) down

reset:           ## Arrête et efface les données
	$(COMPOSE) down -v

logs:            ## Journaux agrégés
	$(COMPOSE) logs -f

seed:            ## Jeu de données de démonstration -- idempotent (D21, amoa/07-demonstration.md)
	# `make up` seul n'installe jamais le module babana (compose.dev.yaml : `odoo --dev=reload`,
	# sans `-i`) : sur une base fraîche il faut donc l'installer avant de semer. `-i` sur un
	# module déjà installé ne fait que recharger le registre -- l'étape reste idempotente. Même
	# `sh -c '... --db_host=...'` que `make test` : `docker compose exec` ne passe pas par
	# l'entrypoint de l'image qui traduit HOST/USER/PASSWORD d'ordinaire.
	$(COMPOSE) exec -T odoo sh -c 'odoo -d babana --stop-after-init --no-http -i babana --db_host="$$HOST" --db_user="$$USER" --db_password="$$PASSWORD"'
	$(COMPOSE) exec -T odoo sh -c 'odoo shell -d babana --no-http --db_host="$$HOST" --db_user="$$USER" --db_password="$$PASSWORD"' < services/odoo/scripts/seed.py

seed-drivers:    ## Tient les chauffeurs semés en ligne, à des positions dispersées (Ctrl-C pour arrêter)
	# Le pool géo-indexé du service temps réel n'a qu'un seul écrivain (D26) : ce compagnon de
	# `make seed` ouvre une connexion WebSocket par chauffeur semé (vrai /auth/google -> WS ->
	# availability.set + position.update), il n'écrit jamais Redis directement.
	node services/realtime/scripts/demo-drivers.mjs

client:          ## Démarre l'app Client
	npm run start -w @babana/client

driver:          ## Démarre l'app Chauffeur
	npm run start -w @babana/driver

test:            ## Tests de tous les paquets et services, plus la suite Odoo
	# La suite Odoo (module babana, jamais installé par `make up` seul) vient AVANT `npm test` :
	# test/concurrency et test/auth (L4-11, C-01 critère 5) parlent au vrai `/api/v1` par HTTP,
	# qui n'existe que si le module est déjà installé. Sur une base fraîche (`make reset && make
	# up`), l'ordre inverse fait échouer npm test avec un 404 sur /auth/google avant même que ce
	# module n'ait existé -- masqué jusqu'ici par une base jamais vraiment vierge au moment de
	# `make test` (CLAUDE.md, "la base de développement est jetable"). sh -c '... --db_host=...'
	# : `docker compose exec` ne passe pas par l'entrypoint de l'image, qui est ce qui traduit
	# HOST/USER/PASSWORD en --db_host/--db_user/--db_password d'habitude -- sans ça, odoo tente
	# une connexion locale et échoue (trouvé en vérifiant L0-02). --http-port=8070 : le process
	# principal du conteneur écoute déjà 8069, et --test-enable démarre un serveur HTTP même avec
	# --stop-after-init.
	$(COMPOSE) exec -T odoo sh -c 'odoo -d babana --test-enable --stop-after-init -i babana --http-port=8070 --db_host="$$HOST" --db_user="$$USER" --db_password="$$PASSWORD"'
	npm test

lint:            ## Lint de tous les espaces de travail
	npm run lint --workspaces --if-present

typecheck:       ## tsc --noEmit sur tout l'arbre (définition de fini, CLAUDE.md #4)
	npm run typecheck --workspaces --if-present

verify:          ## Vérifications d'infrastructure après `make up` (L0-01, critères 2/5/6)
	sh infra/smoke-test.sh

secrets-scan:    ## Recherche automatisée de secrets (L0-01, critère 4 ; invariant 5)
	sh tools/secret-scan/scan.sh
