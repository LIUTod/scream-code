.DEFAULT_GOAL := prepare

.PHONY: help
help: ## Show available make targets.
	@echo "Available make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[A-Za-z0-9_.-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: install-prek
install-prek: ## Install prek and repo git hooks.
	@echo "==> Installing prek"
	@uv tool install prek
	@echo "==> Installing git hooks with prek"
	@uv tool run prek install

.PHONY: prepare
prepare: download-deps install-prek ## Sync dependencies for all workspace packages and install prek hooks.
	@echo "==> Syncing dependencies for all workspace packages"
	@uv sync --frozen --all-extras --all-packages

.PHONY: prepare-build
prepare-build: download-deps ## Sync dependencies for releases without workspace sources.
	@echo "==> Syncing dependencies for release builds (no sources)"
	@uv sync --all-extras --all-packages --no-sources

.PHONY: format format-scream-cli format-ltod format-pykaos format-scream-sdk
format: format-scream-cli format-ltod format-pykaos format-scream-sdk ## Auto-format all workspace packages.
format-scream-cli: ## Auto-format Scream Code CLI sources with ruff.
	@echo "==> Formatting Scream Code CLI sources"
	@uv run ruff check --fix
	@uv run ruff format
format-ltod: ## Auto-format ltod sources with ruff.
	@echo "==> Formatting ltod sources"
	@uv run --project packages/ltod --directory packages/ltod ruff check --fix
	@uv run --project packages/ltod --directory packages/ltod ruff format
format-pykaos: ## Auto-format pykaos sources with ruff.
	@echo "==> Formatting pykaos sources"
	@uv run --project packages/kaos --directory packages/kaos ruff check --fix
	@uv run --project packages/kaos --directory packages/kaos ruff format
format-scream-sdk: ## Auto-format scream-sdk sources with ruff.
	@echo "==> Formatting scream-sdk sources"
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk ruff check --fix
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk ruff format

.PHONY: check check-scream-cli check-ltod check-pykaos check-scream-sdk
check: check-scream-cli check-ltod check-pykaos check-scream-sdk ## Run linting and type checks for all packages.
check-scream-cli: ## Run linting and type checks for Scream Code CLI.
	@echo "==> Checking Scream Code CLI (ruff + pyright + ty; ty is non-blocking)"
	@uv run ruff check
	@uv run ruff format --check
	@uv run pyright
	@uv run ty check || true
check-ltod: ## Run linting and type checks for ltod.
	@echo "==> Checking ltod (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project packages/ltod --directory packages/ltod ruff check
	@uv run --project packages/ltod --directory packages/ltod ruff format --check
	@uv run --project packages/ltod --directory packages/ltod pyright
	@uv run --project packages/ltod --directory packages/ltod ty check || true
check-pykaos: ## Run linting and type checks for pykaos.
	@echo "==> Checking pykaos (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project packages/kaos --directory packages/kaos ruff check
	@uv run --project packages/kaos --directory packages/kaos ruff format --check
	@uv run --project packages/kaos --directory packages/kaos pyright
	@uv run --project packages/kaos --directory packages/kaos ty check || true
check-scream-sdk: ## Run linting and type checks for scream-sdk.
	@echo "==> Checking scream-sdk (ruff + pyright + ty; ty is non-blocking)"
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk ruff check
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk ruff format --check
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk pyright
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk ty check || true

.PHONY: test test-scream-cli test-ltod test-pykaos test-scream-sdk
test: test-scream-cli test-ltod test-pykaos test-scream-sdk ## Run all test suites.
test-scream-cli: ## Run Scream Code CLI tests.
	@echo "==> Running Scream Code CLI tests"
	@uv run pytest tests -vv
	@uv run pytest tests_e2e -vv
test-ltod: ## Run ltod tests (including doctests).
	@echo "==> Running ltod tests"
	@uv run --project packages/ltod --directory packages/ltod pytest --doctest-modules -vv
test-pykaos: ## Run pykaos tests.
	@echo "==> Running pykaos tests"
	@uv run --project packages/kaos --directory packages/kaos pytest tests -vv
test-scream-sdk: ## Run scream-sdk tests.
	@echo "==> Running scream-sdk tests"
	@uv run --project sdks/scream-sdk --directory sdks/scream-sdk pytest tests -vv

.PHONY: build build-scream-cli build-ltod build-pykaos build-scream-sdk
build: build-scream-cli build-ltod build-pykaos build-scream-sdk ## Build Python packages for release.
build-scream-cli: ## Build the scream-cli and scream-code sdists and wheels.
	@echo "==> Injecting build SHA"
	@uv run scripts/inject_build_sha.py
	@echo "==> Building scream-cli distributions"
	@uv build --package scream-cli --no-sources --out-dir dist
	@echo "==> Building scream-code distributions"
	@uv build --package scream-code --no-sources --out-dir dist
build-ltod: ## Build the ltod sdist and wheel.
	@echo "==> Building ltod distributions"
	@uv build --package ltod --no-sources --out-dir dist/ltod
build-pykaos: ## Build the pykaos sdist and wheel.
	@echo "==> Building pykaos distributions"
	@uv build --package pykaos --no-sources --out-dir dist/pykaos
build-scream-sdk: ## Build the scream-sdk sdist and wheel.
	@echo "==> Building scream-sdk distributions"
	@uv build --package scream-sdk --no-sources --out-dir dist/scream-sdk

.PHONY: ai-test
ai-test: ## Run the test suite with Scream Code CLI.
	@echo "==> Running AI test suite"
	@uv run tests_ai/scripts/run.py tests_ai

include src/scream/deps/Makefile
