# =============================================================================
# NuTube CI Simulation Makefile
# =============================================================================
# Run `make ci` before pushing to simulate the full CI pipeline locally.
# Run `make ci-quick` for faster iteration (skips E2E tests).
#
# Individual targets mirror GitHub Actions jobs:
#   make typecheck  - TypeScript compilation check
#   make lint       - ESLint
#   make test       - Unit tests with coverage
#   make build      - Build extension + verify artifacts
#   make e2e        - E2E tests (requires build)
#   make security   - npm security audit
# =============================================================================

.PHONY: all ci ci-run ci-summary ci-quick ci-quick-run ci-quick-summary typecheck lint test build verify-build e2e security clean help

# Default target
all: ci

# =============================================================================
# Full CI Pipeline (mirrors GitHub Actions)
# =============================================================================
ci:
	@$(MAKE) ci-run 2>&1 | tee /tmp/nutube-ci.log; \
	EXIT_CODE=$${PIPESTATUS[0]}; \
	$(MAKE) ci-summary EXIT_CODE=$$EXIT_CODE; \
	exit $$EXIT_CODE

# Internal target that runs the actual CI steps
ci-run: typecheck lint test build e2e

# Generate summary table from CI log
ci-summary:
	@printf '\n\n'
	@echo "┌───────────────────────────────────┬──────────┐"
	@echo "│              Check                │  Result  │"
	@echo "├───────────────────────────────────┼──────────┤"
	@LOG=/tmp/nutube-ci.log; \
	if grep -q "tsc --noEmit" $$LOG; then \
		if grep -A1 "tsc --noEmit" $$LOG | grep -q "error\|Error" 2>/dev/null; then \
			printf "│ %-33s │ %-7s │\n" "TypeScript (tsc --noEmit)" "❌ Fail "; \
		else \
			printf "│ %-33s │ %-7s │\n" "TypeScript (tsc --noEmit)" "✅ Pass "; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Running ESLint" $$LOG; then \
		if grep -A5 "Running ESLint" $$LOG | grep -q "error\|problem" 2>/dev/null; then \
			printf "│ %-33s │ %-7s │\n" "ESLint" "❌ Fail "; \
		else \
			printf "│ %-33s │ %-7s │\n" "ESLint" "✅ Pass "; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Running unit tests" $$LOG; then \
		TESTS=$$(grep -oE "Tests[[:space:]]+[0-9]+ passed" $$LOG | grep -oE "[0-9]+" | head -1); \
		if [ -n "$$TESTS" ]; then \
			printf "│ %-33s │ %-7s │\n" "Unit Tests ($$TESTS tests)" "✅ Pass "; \
		elif grep -q "FAIL\|failed" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Unit Tests" "❌ Fail "; \
		else \
			printf "│ %-33s │ %-7s │\n" "Unit Tests" "✅ Pass "; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Building extension" $$LOG; then \
		if grep -q "Build complete" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Build" "✅ Pass "; \
		else \
			printf "│ %-33s │ %-7s │\n" "Build" "❌ Fail "; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Manifest validation" $$LOG; then \
		if grep -q "Manifest validation passed" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Manifest Validation" "✅ Pass "; \
		else \
			printf "│ %-33s │ %-7s │\n" "Manifest Validation" "❌ Fail "; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Running E2E tests" $$LOG; then \
		E2E_TESTS=$$(grep -oE "[0-9]+ passed" $$LOG | tail -1 | grep -oE "[0-9]+"); \
		if [ -n "$$E2E_TESTS" ] && ! grep -q "failed" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "E2E Tests ($$E2E_TESTS tests)" "✅ Pass "; \
		else \
			FAILED=$$(grep -oE "[0-9]+ failed" $$LOG | tail -1 | grep -oE "[0-9]+"); \
			if [ -n "$$FAILED" ]; then \
				printf "│ %-33s │ %-7s │\n" "E2E Tests ($$FAILED failed)" "❌ Fail "; \
			else \
				printf "│ %-33s │ %-7s │\n" "E2E Tests" "❌ Fail "; \
			fi; \
		fi; \
	fi; \
	echo "└───────────────────────────────────┴──────────┘"
	@echo ""
	@if [ "$(EXIT_CODE)" = "0" ]; then \
		echo "✅ All CI checks passed!"; \
	else \
		echo "❌ CI checks failed!"; \
	fi
	@echo ""

# Quick CI (skips E2E for faster iteration)
ci-quick:
	@$(MAKE) ci-quick-run 2>&1 | tee /tmp/nutube-ci.log; \
	EXIT_CODE=$${PIPESTATUS[0]}; \
	$(MAKE) ci-quick-summary EXIT_CODE=$$EXIT_CODE; \
	exit $$EXIT_CODE

# Internal target for quick CI
ci-quick-run: typecheck lint test build

# Generate summary table for quick CI
ci-quick-summary:
	@printf '\n\n'
	@echo "┌───────────────────────────────────┬──────────┐"
	@echo "│              Check                │  Result  │"
	@echo "├───────────────────────────────────┼──────────┤"
	@LOG=/tmp/nutube-ci.log; \
	if grep -q "tsc --noEmit" $$LOG; then \
		if grep -A1 "tsc --noEmit" $$LOG | grep -q "error\|Error" 2>/dev/null; then \
			printf "│ %-33s │ %-7s │\n" "TypeScript (tsc --noEmit)" "❌ Fail"; \
		else \
			printf "│ %-33s │ %-7s │\n" "TypeScript (tsc --noEmit)" "✅ Pass"; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Running ESLint" $$LOG; then \
		if grep -A5 "Running ESLint" $$LOG | grep -q "error\|problem" 2>/dev/null; then \
			printf "│ %-33s │ %-7s │\n" "ESLint" "❌ Fail"; \
		else \
			printf "│ %-33s │ %-7s │\n" "ESLint" "✅ Pass"; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Running unit tests" $$LOG; then \
		TESTS=$$(grep -oE "Tests[[:space:]]+[0-9]+ passed" $$LOG | grep -oE "[0-9]+" | head -1); \
		if [ -n "$$TESTS" ]; then \
			printf "│ %-33s │ %-7s │\n" "Unit Tests ($$TESTS tests)" "✅ Pass"; \
		elif grep -q "FAIL\|failed" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Unit Tests" "❌ Fail"; \
		else \
			printf "│ %-33s │ %-7s │\n" "Unit Tests" "✅ Pass"; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Building extension" $$LOG; then \
		if grep -q "Build complete" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Build" "✅ Pass"; \
		else \
			printf "│ %-33s │ %-7s │\n" "Build" "❌ Fail"; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	if grep -q "Manifest validation" $$LOG; then \
		if grep -q "Manifest validation passed" $$LOG; then \
			printf "│ %-33s │ %-7s │\n" "Manifest Validation" "✅ Pass"; \
		else \
			printf "│ %-33s │ %-7s │\n" "Manifest Validation" "❌ Fail"; \
		fi; \
	fi; \
	echo "├───────────────────────────────────┼──────────┤"; \
	printf "│ %-33s │ %-7s │\n" "E2E Tests" "⏭️ Skip"; \
	echo "└───────────────────────────────────┴──────────┘"
	@echo ""
	@if [ "$(EXIT_CODE)" = "0" ]; then \
		echo "✅ Quick CI checks passed (E2E skipped)"; \
	else \
		echo "❌ CI checks failed!"; \
	fi
	@echo ""

# =============================================================================
# TypeScript Check (mirrors: jobs.typecheck)
# =============================================================================
typecheck:
	@echo "🔍 Running TypeScript check..."
	npm run typecheck

# =============================================================================
# ESLint (mirrors: jobs.lint)
# =============================================================================
lint:
	@echo "🔍 Running ESLint..."
	npm run lint

# Fix lint errors automatically
lint-fix:
	@echo "🔧 Fixing lint errors..."
	npm run lint:fix

# =============================================================================
# Unit Tests (mirrors: jobs.test)
# =============================================================================
test:
	@echo "🧪 Running unit tests with coverage..."
	npm run test:coverage

# Run tests in watch mode (for development)
test-watch:
	npm run test:watch

# =============================================================================
# Build Extension (mirrors: jobs.build)
# =============================================================================
build:
	@echo "🏗️  Building extension..."
	npm run build
	@$(MAKE) verify-build

# Verify build artifacts (mirrors the CI verification step)
verify-build:
	@echo "🔍 Verifying build artifacts..."
	@echo "Checking dist/ contents..."
	@ls -la dist/
	@echo ""
	@echo "Verifying required files..."
	@test -f dist/manifest.json || (echo "❌ Missing manifest.json" && exit 1)
	@test -f dist/background.js || (echo "❌ Missing background.js" && exit 1)
	@test -f dist/content.js || (echo "❌ Missing content.js" && exit 1)
	@test -f dist/dashboard.html || (echo "❌ Missing dashboard.html" && exit 1)
	@test -f dist/dashboard.js || (echo "❌ Missing dashboard.js" && exit 1)
	@echo ""
	@echo "Validating manifest.json..."
	@node -e " \
		const manifest = require('./dist/manifest.json'); \
		if (manifest.manifest_version !== 3) { \
			console.error('❌ Expected manifest_version 3'); \
			process.exit(1); \
		} \
		const required = ['name', 'version', 'permissions', 'background']; \
		for (const field of required) { \
			if (!manifest[field]) { \
				console.error('❌ Missing required field: ' + field); \
				process.exit(1); \
			} \
		} \
		console.log('✅ Manifest validation passed!'); \
		console.log('   Extension:', manifest.name, 'v' + manifest.version); \
	"

# =============================================================================
# E2E Tests (mirrors: jobs.e2e)
# =============================================================================
e2e: build
	@echo "🎭 Running E2E tests..."
	npm run test:e2e

# E2E with Playwright UI (for debugging)
e2e-ui: build
	npm run test:e2e:ui

# Install Playwright browsers (run once)
e2e-setup:
	npx playwright install chromium --with-deps

# =============================================================================
# Security Audit (mirrors: jobs.security)
# =============================================================================
security:
	@echo "🔒 Running security audit..."
	npm audit --audit-level=high || true

# Strict security audit (fails on any vulnerability)
security-strict:
	@echo "🔒 Running strict security audit..."
	npm audit

# =============================================================================
# Development Helpers
# =============================================================================
# Install dependencies
install:
	npm ci

# Clean build artifacts
clean:
	rm -rf dist/ coverage/ playwright-report/ test-results/

# Watch mode for development
dev:
	npm run dev

# =============================================================================
# Help
# =============================================================================
help:
	@echo "NuTube CI Simulation"
	@echo ""
	@echo "CI Targets:"
	@echo "  make ci          - Run full CI pipeline (typecheck, lint, test, build, e2e)"
	@echo "  make ci-quick    - Run CI without E2E tests (faster)"
	@echo ""
	@echo "Individual Checks:"
	@echo "  make typecheck   - TypeScript compilation check"
	@echo "  make lint        - ESLint check"
	@echo "  make lint-fix    - Auto-fix lint errors"
	@echo "  make test        - Unit tests with coverage"
	@echo "  make build       - Build extension and verify artifacts"
	@echo "  make e2e         - E2E tests (builds first)"
	@echo "  make security    - npm security audit"
	@echo ""
	@echo "Development:"
	@echo "  make dev         - Watch mode for development"
	@echo "  make test-watch  - Run tests in watch mode"
	@echo "  make e2e-ui      - E2E tests with Playwright UI"
	@echo "  make e2e-setup   - Install Playwright browsers"
	@echo "  make clean       - Remove build artifacts"
	@echo "  make install     - Install dependencies (npm ci)"
