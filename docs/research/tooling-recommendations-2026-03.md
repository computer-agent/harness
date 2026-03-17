# Tooling & Workflow Recommendations — 2026-03-17

Research from three parallel agents: code review, static analysis, workflow optimization.

## Current Toolchain
- Biome (lint + format)
- Knip (dead code detection)
- TypeScript strict mode
- Node.js built-in test runner (src/*.test.ts)
- Ad-hoc integration tests (tests/*.mjs)

## Add Now
- **Playwright + @axe-core/playwright** — E2E + automated a11y testing
- **Gitleaks** — secret scanning in CI (GitHub Action)
- **GitHub Actions CI** — typecheck + lint + unit tests on push; integration tests on PR
- **Husky pre-commit** — `npm run lint:fix && npm run test:unit`

## Add Later (Phase 3-4)
- **Lighthouse CI** — perf budgets at deploy time
- **Socket.dev** — supply chain attack detection (when >50 deps)
- **TruffleHog** — credential verification in CI
- **Vitest** — frontend hook unit tests (when web is 80% built)
- **Playwright E2E in CI** — when staging env exists

## Skip
- Stylelint (Tailwind v4 handles tree-shaking)
- React Compiler (bottleneck is API latency)
- Semgrep/CodeQL (Biome + TS cover it)
- Chromatic/Percy (no Storybook)
- Turborepo/nx (2 packages, overkill)
- Jest migration (Node.js test runner is fine)

## CI Pipeline Shape
```yaml
# On every push:
- npm ci
- npm run typecheck
- npx biome check
- npm run test:unit
- cd web && npm run build

# On PR:
- All above + integration tests (start server, run tests/*.mjs)
- Gitleaks scan
```

## Pre-commit Hook
```bash
npx lint-staged  # biome check --write on staged files
npm run test:unit
```

## Test Structure Target
```
tests/
├── integration/
│   ├── helpers.mjs        # Shared utilities (waitForMessage, etc.)
│   ├── protocol.test.mjs  # WS protocol tests
│   ├── conversation.test.mjs
│   └── tools.test.mjs
src/**/*.test.ts           # Unit tests (Node.js test runner)
web/tests/                 # Frontend tests (Vitest, later)
```

## Code Review Summary
17 issues found, spec at `docs/FIXES-code-review.md`:
- 3 Critical: CORS, unhandled WS errors, persistence race
- 4 High: buffer leak, XSS markdown, session race, markdown error boundary
- 5 Medium: token storage, stale closures, Zustand state, localStorage, fetch timeout
- 5 Low: validation, refs, memo, exports, error keys

Execution: 5 agents in 2 waves (wave 1: agents 1-3 parallel, wave 2: agents 4-5 after).
