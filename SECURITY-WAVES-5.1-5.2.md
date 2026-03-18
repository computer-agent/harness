# Security Waves 5.1 + 5.2 — Validation Sprint + Deferred Fixes

Source: Three parallel reviews (security, engineering, architecture) of Wave 5 implementation.

## Sequencing Rationale

**Wave 5.1 (Validation Sprint)** validates the 15 review fixes already applied. Grouped by test surface:
- IPC + lifecycle fixes are deeply intertwined — can't test P0-1 without also exercising F1, F2, P1-3
- Mutex gets dedicated validation because the while→queue rewrite was a correctness fix
- Security hardening fixes (F3, F5, F7) share a running-server test surface
- Worker behavior (prompt rebuild, shutdown grace) and env isolation are smaller clusters

**Wave 5.2 (Deferred Fixes)** sequences by dependency:
- SDK stream processor (W5.2-T01) is the largest, touches TUI + worker, no deps — goes first
- Timeout-related items (W5.2-T03, W5.2-T06) can parallel
- Config/health items (W5.2-T08, W5.2-T09) are directly related, T09 depends on T08
- Everything else is standalone

---

## Wave 5.1: Validation Sprint

Estimated effort: 2-3 days. All tasks are writing tests for already-applied fixes.

### W5.1-T01: IPC Round-Trip and Worker Lifecycle Integration Tests (medium)

**Validates:** P0-1 (exit-settles-promise), F1 (kill-on-resubscribe), F2 (frame-allowlist), worker spawn/crash/shutdown

Highest priority — P0-1 was a deadlock bug.

| # | Validation |
|---|-----------|
| 1 | Integration test: spawn real worker (fork), send init + message IPC, verify frames arrive and result resolves |
| 2 | Integration test: SIGKILL mid-query — promise rejects (not hangs), mutex releases |
| 3 | Integration test: worker exits code 0 after shutdown during query — promise resolves with result |
| 4 | Integration test: worker exits non-zero — promise rejects |
| 5 | Integration test: worker sends frame with `type: "evil_payload"` — parent rejects, does NOT relay |
| 6 | Integration test: worker sends valid frame types (token, tool_use_start, status) — all relay correctly |
| 7 | Integration test: re-subscribe on same WS — previous worker killed before new one spawns |
| 8 | Verify `settled` flag prevents double-resolve/double-reject |
| 9 | All integration tests pass 5 consecutive runs without flakiness |

### W5.1-T02: Mutex Queue Correctness Under Contention (small)

**Validates:** QueryMutex rewrite from while-loop to queue, FIFO ordering, no starvation

| # | Validation |
|---|-----------|
| 1 | Stress test: 10+ concurrent acquires on same key — strict FIFO execution order |
| 2 | Stress test: 5 keys × 3 acquires — cross-key concurrency verified |
| 3 | Release while waiters queued — exactly one waiter wakes (not all) |
| 4 | Double-release is no-op — mutex state clean |
| 5 | Acquire-release-acquire cycle — no stale queue entries |
| 6 | Existing mutex tests continue to pass |

### W5.1-T03: Security Hardening Fixes Validation (medium)

**Validates:** F3 (execArgv --inspect filter), F5 (token-hash rate-limit key), F7 (roster filter), safeCompare

| # | Validation |
|---|-----------|
| 1 | execArgv: `--inspect` stripped, `--import=tsx` preserved |
| 2 | execArgv: `--inspect-brk` and `--debug` stripped |
| 3 | Rate limit keyGenerator produces 64-char hex from bearer token |
| 4 | Roster broadcast on config change filtered per user access |
| 5 | Manual reload roster filtered per user access |
| 6 | connectedClients stores tokenHash, not raw token |

### W5.1-T04: Worker Behavior Validation (small)

**Validates:** A1 (system-prompt-rebuild), P2-4 (execArgv-tsx), shutdown grace period

| # | Validation |
|---|-----------|
| 1 | handleMessage calls `buildSystemPrompt()` with current time |
| 2 | handleMessage reuses cached manifest from init |
| 3 | Fork with tsx execArgv imports TS modules successfully |
| 4 | Shutdown during query: result sent, exits within 5s |
| 5 | Shutdown with no query: immediate exit |

### W5.1-T05: Worker Environment Isolation (small)

**Validates:** W5-T04 per-worker env, no secret leakage, ANTHROPIC_API_KEY passthrough

| # | Validation |
|---|-----------|
| 1 | Worker env contains only safe vars + ANTHROPIC_API_KEY + WORKER_* |
| 2 | Parent `DATABASE_URL` does NOT appear in worker env |
| 3 | ANTHROPIC_API_KEY passes through correctly |
| 4 | Missing ANTHROPIC_API_KEY omitted (no empty string) |
| 5 | Agent-specific env vars from `loadAgentEnv` appear via `buildShellEnv` |

---

## Wave 5.2: Deferred Fixes

Estimated effort: 1-2 weeks. Mix of small standalone fixes and one larger refactor.

### W5.2-T01: SDK Stream Processing Shared Abstraction (large)

**Source:** Architecture Review #2

Extract `SdkStreamProcessor` shared between session-worker.ts and App.tsx. Both files independently parse the same SDK message types through `as any` casts. Single abstraction removes the `as any` explosion and ensures changes propagate to both paths.

**Files:** New `src/sdk-stream.ts`, `src/session-worker.ts`, `src/components/App.tsx`

| # | Validation |
|---|-----------|
| 1 | SdkStreamProcessor extracted to src/sdk-stream.ts |
| 2 | session-worker.ts uses shared processor |
| 3 | App.tsx uses shared processor |
| 4 | No behavioral regression in TUI stream rendering |
| 5 | No behavioral regression in remote WS frame streaming |

### W5.2-T02: Double Error on Worker Init Failure (small)

**Source:** Architecture Review #5

Worker init failure sends `sendError` IPC + `process.exit(1)`. Parent receives both the error frame and the exit event, producing two error messages to the client. Fix: single error path.

**Files:** `src/session-worker.ts`, `src/serve.ts`

| # | Validation |
|---|-----------|
| 1 | Worker init failure sends exactly one error to client |
| 2 | Error includes meaningful message from the init failure |
| 3 | Worker still exits non-zero on init failure |

### W5.2-T03: QueryMutex Timeout (small)

**Source:** Security Review F4

Add optional `timeoutMs` to `acquire()`. On timeout, waiter removed from queue, error thrown. Prevents permanent lockout from stuck workers.

**Files:** `src/query-mutex.ts`, `src/serve.ts`, `src/session-worker.test.ts`

| # | Validation |
|---|-----------|
| 1 | `acquire(key, timeoutMs)` throws after timeout |
| 2 | Timed-out waiter removed from queue |
| 3 | Existing tests pass with default timeout |
| 4 | New test: 100ms timeout on locked key throws within 200ms |

### W5.2-T04: Token Revocation safeCompare (small)

**Source:** Security Review F6

`onAccessChange` uses `===` for tokenHash comparison. Use timing-safe `safeCompare` for defense-in-depth.

**Files:** `src/access.ts`, `src/serve.ts`

| # | Validation |
|---|-----------|
| 1 | `safeCompare` exported from access.ts |
| 2 | onAccessChange uses safeCompare for tokenHash comparison |
| 3 | Token revocation still disconnects revoked users |

### W5.2-T05: WebSocket Message Schema Validation (medium)

**Source:** Security Review F8

Add Zod schema for `WsClientMessage`. Validate after `JSON.parse`. Reject with structured error on schema failure.

**Files:** `src/serve.ts` (or new `src/ws-protocol.ts`)

| # | Validation |
|---|-----------|
| 1 | Zod schema defined for all WS client message types |
| 2 | Invalid schema sends structured error to client |
| 3 | Valid messages processed normally |
| 4 | Test: `content` as number rejected, as string accepted |

### W5.2-T06: Worker Ready Timeout (small)

**Source:** Security Review F10

After spawn, if "ready" not received within 30s, kill worker and reject. Prevents permanent lockout from stuck agent loading.

**Files:** `src/serve.ts`, `src/worker-manager.ts`

| # | Validation |
|---|-----------|
| 1 | Timeout fires if worker does not send "ready" within 30s |
| 2 | Worker killed on ready timeout |
| 3 | Promise rejects with meaningful error |
| 4 | Mutex released on ready timeout |
| 5 | Normal workers unaffected |

### W5.2-T07: Pending Approval Cleanup on Worker Crash (small)

**Source:** Engineering Review P2-3

Worker crash leaves `pendingApprovals` map entries dangling. Clear on worker exit, send rejection frame to client.

**Files:** `src/serve.ts`

| # | Validation |
|---|-----------|
| 1 | Worker crash clears pendingApprovals map |
| 2 | Client receives rejection frame for each pending approval |
| 3 | No stale approval prompts in UI after crash |

### W5.2-T08: Configurable maxWorkers in HarnessConfig (small)

**Source:** Engineering Review P3-3

Add `serve.maxWorkers` to config. Default 20. Pass to WorkerManager constructor.

**Files:** `src/config.ts`, `src/serve.ts`

| # | Validation |
|---|-----------|
| 1 | `serve.maxWorkers` in HarnessConfig interface |
| 2 | Default value 20 |
| 3 | WorkerManager receives config value |
| 4 | config.yaml can override |

### W5.2-T09: Worker Pool Size in /health/deep (small)

**Source:** Architecture Review #3

Expose `workerPool: { active, max, utilization }` in deep health response.

**Files:** `src/health.ts`, `src/serve.ts`

**Depends on:** W5.2-T08

| # | Validation |
|---|-----------|
| 1 | DeepHealth includes workerPool object |
| 2 | `active` matches workerManager.size |
| 3 | `max` matches configured maxWorkers |
| 4 | `utilization` = active/max (0.0–1.0) |

---

## Summary

| Wave | Tasks | Scope | Est. Effort |
|------|-------|-------|-------------|
| 5.1 (Validation) | 5 tasks | Tests only | 2-3 days |
| 5.2 (Deferred) | 9 tasks | 1 large + 8 small | 1-2 weeks |

Critical path: W5.1-T01 (lifecycle integration tests) → W5.1-T02 (mutex stress) must pass before any W5.2 work begins. The validation sprint proves the review fixes are correct; the deferred wave hardens and polishes.
