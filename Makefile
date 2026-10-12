# KG Studio — common tasks.  `make help` lists them.
.DEFAULT_GOAL := help
PY := .venv/bin/python

.PHONY: help setup dev build serve test lint up up-ollama down logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

# ---- local (no Docker) ----
setup: ## Create .venv, install backend + web dependencies, create .env
	./scripts/setup.sh

dev: ## Run backend (:8000) + hot-reloading UI (:5173)
	./scripts/dev.sh

build: ## Build the web UI into studio/web/dist (served by the backend)
	cd studio/web && npm run build

serve: build ## Build the UI and serve everything from http://localhost:8000
	$(PY) -m kgstudio

test: ## Run backend tests (fake LLM, no network) and type-check/build the UI
	cd studio/backend && ../../$(PY) -m pytest -q
	cd studio/web && npm run build

lint: ## Lint the web UI
	cd studio/web && npm run lint

# ---- Docker ----
up: ## docker compose: build and start KG Studio on http://localhost:8000
	docker compose up -d --build
	@echo "KG Studio → http://localhost:$${STUDIO_PORT:-8000}"

up-ollama: ## docker compose: KG Studio + a bundled Ollama (set LLM_BASE_URL=http://ollama:11434)
	docker compose --profile ollama up -d --build
	@echo "KG Studio → http://localhost:$${STUDIO_PORT:-8000}  (first start pulls the model; see: make logs)"

down: ## Stop all containers
	docker compose --profile ollama down

logs: ## Follow container logs
	docker compose --profile ollama logs -f

clean: ## Remove build artifacts (keeps .venv, node_modules and output/)
	rm -rf studio/web/dist studio/backend/*.egg-info .pytest_cache studio/backend/.pytest_cache
