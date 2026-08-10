COMPOSE = docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env

.PHONY: up down logs reset seed client driver test lint typecheck verify secrets-scan

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

seed:            ## Jeu de données de démonstration
	$(COMPOSE) exec -T odoo odoo shell -d babana --no-http < services/odoo/scripts/seed.py

client:          ## Démarre l'app Client
	npm run start -w @babana/client

driver:          ## Démarre l'app Chauffeur
	npm run start -w @babana/driver

test:            ## Tests de tous les paquets et services, plus la suite Odoo
	npm test
	$(COMPOSE) exec -T odoo odoo -d babana --test-enable --stop-after-init -i babana

lint:            ## Lint de tous les espaces de travail
	npm run lint --workspaces --if-present

typecheck:       ## tsc --noEmit sur tout l'arbre (définition de fini, CLAUDE.md #4)
	npm run typecheck --workspaces --if-present

verify:          ## Vérifications d'infrastructure après `make up` (L0-01, critères 2/5/6)
	sh infra/smoke-test.sh

secrets-scan:    ## Recherche automatisée de secrets (L0-01, critère 4 ; invariant 5)
	sh tools/secret-scan/scan.sh
