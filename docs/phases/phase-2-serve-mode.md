# Phase 2: Serve Mode

HTTP/WebSocket server so agents are accessible via API. Test with curl and wscat — no frontend in this phase.

**Depends on:** Phase 1 (frontmatter parsing, tool filtering, `AgentManifest` type, `listAgents()`)

**SDK API:** V1 `query()` with `resume` option. NOT V2 unstable API.

**Reference implementation:** `simple-chatapp` demo in claude-agent-sdk-demos. We diverge significantly — that demo uses a long-lived `query()` with an async message queue as input. We use one `query()` call per user message with `resume` to continue conversations, matching how the TUI works today.

---

## 2.0 Pre-work: Fix Global State

These three tasks must land before any server code. The current codebase assumes a single agent per process. Serve mode runs multiple agents concurrently in one process.

---

### 2.0a Remove process.chdir()

**Requirement:** Eliminate the global `process.chdir()` call and thread `cwd` explicitly to every consumer.

**Current state:**

- `src/index.tsx:153` calls `process.chdir(agentContext.workspaceDir)` at startup
- `src/tools/index.ts:17` reads `const cwd = process.cwd()` and passes it to `createWorkspaceTools(cwd)` and `createShellTools(cwd)`
- Both `createShellTools()` and `createWorkspaceTools()` accept `cwd` as a parameter already — they just get it from the global

**Changes:**

1. **`src/tools/index.ts`** — `createAgentServers()` must accept an explicit `cwd` parameter instead of reading `process.cwd()`:

```typescript
// Before
export function createAgentServers(ctx: AgentContext, config: HarnessConfig) {
  const cwd = process.cwd();
  // ...
}

// After
export function createAgentServers(ctx: AgentContext, config: HarnessConfig, cwd: string) {
  // cwd is now a parameter, not read from process
  // ...
}
```

2. **`src/agent.ts`** — `buildOptions()` must accept `cwd` and pass it through:

```typescript
// Before
export function buildOptions(
  ctx: AgentContext,
  opts: { resume?: string; systemPrompt: string; /* ... */ },
  config: HarnessConfig,
): Options {
  return {
    // ...
    mcpServers: createAgentServers(ctx, config),
  };
}

// After
export function buildOptions(
  ctx: AgentContext,
  opts: { resume?: string; systemPrompt: string; cwd?: string; /* ... */ },
  config: HarnessConfig,
): Options {
  const cwd = opts.cwd ?? ctx.workspaceDir;
  return {
    // ...
    cwd,  // SDK Options supports this field directly
    mcpServers: createAgentServers(ctx, config, cwd),
  };
}
```

The SDK `Options` type already has `cwd?: string` (line 809 of sdk.d.ts: "Current working directory for the session. Defaults to `process.cwd()`."). Pass it explicitly.

3. **`src/index.tsx`** — Remove `process.chdir(agentContext.workspaceDir)` on line 153. Instead, pass `cwd: agentContext.workspaceDir` into `buildOptions()` at every call site:
   - Line 197 (headless `--message` mode)
   - Line 410 (TUI mode, inside `processMessage` in `App.tsx`)

4. **`src/components/App.tsx`** — The `processMessage` callback calls `buildOptions()`. Pass `cwd: agentContext.workspaceDir` in the opts argument.

**Acceptance criteria:**

- `process.chdir` does not appear anywhere in `src/`
- `process.cwd()` does not appear anywhere in `src/` (except potentially in `bin/` entry point for resolving the harness root, which is fine)
- `grep -r "process.chdir\|process.cwd" src/` returns nothing
- TUI mode still starts in the agent's workspace directory (verify with `shell_exec pwd`)
- Headless mode (`--message`) still works identically

**Test plan:**

```bash
# Verify no global state references remain
grep -r "process.chdir\|process.cwd" src/
# Should return nothing

# Verify TUI still works
npx tsx bin/mastersof-ai.js --agent cofounder --message "Run shell_exec with command 'pwd' and tell me the result"
# Output should contain the agent's workspace dir path

# Verify tools get correct cwd
npx tsx bin/mastersof-ai.js --agent cofounder --message "Use list_files to show me what's in the workspace"
# Should list the agent's workspace, not the harness root
```

---

### 2.0b Scope Env Loading

**Requirement:** Agent `.env` values must not pollute `process.env`. Pass them as a scoped object to the SDK and tools.

**Current state:**

- `src/env.ts` — `loadAgentEnv()` calls `dotenvx.config({ path })` which merges parsed values into `process.env` as a side effect
- `src/tools/shell.ts:30` — `createShellTools()` passes `env: { ...process.env }` to child processes, which includes the agent's env vars after loading
- `src/tools/web.ts:61` — `web_search` reads `process.env.BRAVE_API_KEY`
- `src/index.tsx:157` — `loadAgentEnv()` is called before sandbox gate; the returned `agentEnvKeys` record is passed to `execInSandbox()` for bwrap `--setenv` injection

**Changes:**

1. **`src/env.ts`** — Stop polluting `process.env`. Use `dotenvx.config()` with `processEnv` override to prevent global mutation:

```typescript
// Before
export function loadAgentEnv(agentDir: string): Record<string, string> {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return {};
  const result = dotenvx.config({ path: envPath, quiet: true });
  return (result.parsed as Record<string, string>) ?? {};
}

// After
export function loadAgentEnv(agentDir: string): Record<string, string> {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return {};
  // Use a throwaway object so process.env is not mutated
  const container: Record<string, string> = {};
  const result = dotenvx.config({ path: envPath, quiet: true, processEnv: container });
  return (result.parsed as Record<string, string>) ?? {};
}
```

Check the `@dotenvx/dotenvx` API — if `processEnv` is not supported, use `dotenvx.parse()` instead of `dotenvx.config()` to get key-value pairs without side effects. Fallback: read the file manually and use `dotenvx.parse(readFileSync(envPath, "utf-8"))`.

2. **`src/tools/index.ts`** — `createAgentServers()` must accept an `env` parameter and pass it to tool factories that need it:

```typescript
export function createAgentServers(
  ctx: AgentContext,
  config: HarnessConfig,
  cwd: string,
  agentEnv: Record<string, string>,
) {
  // ...
  if (config.tools.web.enabled) {
    servers[`${prefix}web`] = createServer(
      `${prefix}web`,
      createWebTools(config.tools.web, agentEnv),
    );
  }
  if (config.tools.shell.enabled) {
    servers[`${prefix}shell`] = createServer(
      `${prefix}shell`,
      createShellTools(cwd, agentEnv),
    );
  }
  // ...
}
```

3. **`src/tools/shell.ts`** — Merge `agentEnv` into the child process environment instead of relying on `process.env` already containing agent values:

```typescript
// Before
export function createShellTools(defaultCwd: string) {
  // ...
  env: { ...process.env },
  // ...
}

// After
export function createShellTools(defaultCwd: string, agentEnv: Record<string, string> = {}) {
  // ...
  env: { ...process.env, ...agentEnv },
  // ...
}
```

4. **`src/tools/web.ts`** — Accept `agentEnv` and read `BRAVE_API_KEY` from it (falling back to `process.env`):

```typescript
// Before
export function createWebTools(webConfig?: { extraction_model?: string }) {
  // ...
  const apiKey = process.env.BRAVE_API_KEY;
  // ...
}

// After
export function createWebTools(
  webConfig?: { extraction_model?: string },
  agentEnv: Record<string, string> = {},
) {
  // ...
  const apiKey = agentEnv.BRAVE_API_KEY ?? process.env.BRAVE_API_KEY;
  // ...
}
```

5. **`src/agent.ts`** — `buildOptions()` accepts `agentEnv` and passes it through to `createAgentServers()`:

```typescript
export function buildOptions(
  ctx: AgentContext,
  opts: {
    resume?: string;
    systemPrompt: string;
    cwd?: string;
    agentEnv?: Record<string, string>;
    // ...
  },
  config: HarnessConfig,
): Options {
  const cwd = opts.cwd ?? ctx.workspaceDir;
  const agentEnv = opts.agentEnv ?? {};
  return {
    // ...
    cwd,
    mcpServers: createAgentServers(ctx, config, cwd, agentEnv),
  };
}
```

6. **`src/index.tsx`** — Thread `agentEnvKeys` into `buildOptions()` calls:
   - Headless mode (line ~197): `buildOptions(agentContext, { systemPrompt, cwd: agentContext.workspaceDir, agentEnv: agentEnvKeys }, config)`
   - TUI mode: Pass `agentEnvKeys` as a prop to `<App>` and thread through to `buildOptions()` in `processMessage`

**Acceptance criteria:**

- `loadAgentEnv()` does NOT call `dotenvx.config()` in a way that mutates `process.env`
- After `loadAgentEnv()` returns, `process.env` does not contain any keys from the agent's `.env` file
- `shell_exec` child processes still have agent env vars available
- `web_search` still reads `BRAVE_API_KEY` whether it comes from agent `.env` or the system environment
- Two agents loaded in the same process would get their own env scopes (verify conceptually; actual multi-agent test comes with serve mode)

**Test plan:**

```bash
# Create a test .env in an agent dir
echo "TEST_AGENT_VAR=hello_from_env" >> ~/.mastersof-ai/agents/cofounder/.env

# Verify the value is available to tools but not in process.env
npx tsx bin/mastersof-ai.js --agent cofounder --message "Run shell_exec with 'echo \$TEST_AGENT_VAR'"
# Should output: hello_from_env

# Clean up
sed -i '/TEST_AGENT_VAR/d' ~/.mastersof-ai/agents/cofounder/.env
```

---

### 2.0c Error Handling

**Requirement:** Library code (anything importable by serve.ts) must throw errors instead of calling `process.exit()`. Only `bin/` entry points and `src/index.tsx` top-level code may call `process.exit()`.

**Current state — `process.exit()` calls in library code:**

| File | Line | Context |
|------|------|---------|
| `src/agent-context.ts` | 31 | Agent dir not found |
| `src/agent-context.ts` | 35 | IDENTITY.md not found |
| `src/create-agent.ts` | 15 | Agent already exists |

All other `process.exit()` calls are in `src/index.tsx` (CLI entry point) or `src/sandbox.ts` (exec replacement — must exit). Those are fine.

**Changes:**

1. **`src/agent-context.ts`** — `resolveAgent()` throws instead of exiting:

```typescript
// Before
export function resolveAgent(name: string): AgentContext {
  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");
  if (!existsSync(agentDir)) {
    console.error(`Agent "${name}" not found`);
    process.exit(1);
  }
  if (!existsSync(identityPath)) {
    console.error(`Agent "${name}" has no IDENTITY.md`);
    process.exit(1);
  }
  // ...
}

// After
export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`Agent "${name}" not found — ~/.mastersof-ai/agents/${name}/ does not exist`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentMissingIdentityError extends Error {
  constructor(name: string) {
    super(`Agent "${name}" has no IDENTITY.md — ~/.mastersof-ai/agents/${name}/IDENTITY.md not found`);
    this.name = "AgentMissingIdentityError";
  }
}

export function resolveAgent(name: string): AgentContext {
  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");
  if (!existsSync(agentDir)) {
    throw new AgentNotFoundError(name);
  }
  if (!existsSync(identityPath)) {
    throw new AgentMissingIdentityError(name);
  }
  // rest unchanged
}
```

2. **`src/create-agent.ts`** — `createAgent()` throws instead of exiting:

```typescript
// Before
export function createAgent(name: string): void {
  // ...
  if (existsSync(agentDir)) {
    console.error(`Agent "${name}" already exists at ${agentDir}`);
    process.exit(1);
  }
  // ...
}

// After
export class AgentExistsError extends Error {
  constructor(name: string, path: string) {
    super(`Agent "${name}" already exists at ${path}`);
    this.name = "AgentExistsError";
  }
}

export function createAgent(name: string): void {
  const agentsDir = join(getHomeDir(), "agents");
  const agentDir = join(agentsDir, name);
  if (existsSync(agentDir)) {
    throw new AgentExistsError(name, agentDir);
  }
  // rest unchanged
}
```

3. **`src/index.tsx`** — Wrap call sites with try/catch:

```typescript
// Line ~150, resolveAgent
let agentContext: AgentContext;
try {
  agentContext = resolveAgent(agentName);
} catch (err) {
  console.error(formatError(err));
  process.exit(1);
}

// Line ~49, createAgent
try {
  createAgent(name);
} catch (err) {
  console.error(formatError(err));
  process.exit(1);
}
```

**Acceptance criteria:**

- `grep -r "process.exit" src/ | grep -v index.tsx | grep -v sandbox.ts` returns nothing
- `resolveAgent("nonexistent")` throws `AgentNotFoundError`
- `createAgent("existing-agent")` throws `AgentExistsError`
- CLI behavior is unchanged (errors still print and exit with code 1)
- Error classes are exported so serve.ts can catch them specifically and return appropriate HTTP status codes

**Test plan:**

```bash
# Verify process.exit is only in entry points
grep -rn "process.exit" src/ | grep -v "index.tsx" | grep -v "sandbox.ts"
# Should return nothing

# Verify CLI still handles errors gracefully
npx tsx bin/mastersof-ai.js --agent nonexistent 2>&1
# Should print error message and exit 1, same as before
echo $?
# Should be 1
```

---

## 2.1 HTTP/WS Server (`src/serve.ts`)

**Requirement:** A Fastify server with WebSocket support that exposes agents via REST endpoints and a streaming WebSocket.

**Current state:** No server exists. The harness runs as a CLI (TUI or headless).

### New dependency

Add `fastify` and `@fastify/websocket` and `@fastify/cors` to `package.json` dependencies:

```json
{
  "dependencies": {
    "fastify": "^5.3.0",
    "@fastify/websocket": "^12.1.0",
    "@fastify/cors": "^11.0.0"
  }
}
```

### File: `src/serve.ts`

#### Server startup function

```typescript
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import type { AgentManifest } from "./manifest.js";
import type { HarnessConfig } from "./config.js";
import type { AccessConfig } from "./access.js";

export interface ServeOptions {
  port: number;
  host: string;
  config: HarnessConfig;
  access: AccessConfig;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(fastifyCors, {
    origin: true,  // Allow all origins; tighten in production via config
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(fastifyWebsocket);

  // Register routes (defined below)
  registerHealthRoutes(app);
  registerAgentRoutes(app, opts);
  registerSessionRoutes(app, opts);
  registerUsageRoutes(app, opts);
  registerWebSocketRoute(app, opts);

  await app.listen({ port: opts.port, host: opts.host });
}
```

#### REST endpoints

**GET /health**

```typescript
function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", version: PKG_VERSION, uptime: process.uptime() };
  });
}
```

Response schema:
```json
{
  "status": "ok",
  "version": "0.1.5",
  "uptime": 1234.5
}
```

Test:
```bash
curl -s http://localhost:3000/health | jq .
# { "status": "ok", "version": "0.1.5", "uptime": ... }
```

---

**GET /api/agents**

Returns the agent roster filtered by the caller's token. Requires `Authorization: Bearer <token>` header.

The roster is the intersection of:
1. Agents the token grants access to (from `access.yaml`)
2. Agents whose `access` field permits this user (from IDENTITY.md frontmatter)

```typescript
function registerAgentRoutes(app: FastifyInstance, opts: ServeOptions) {
  app.get("/api/agents", async (request, reply) => {
    const user = authenticateRequest(request, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const allAgents = listAgents();  // From Phase 1
    const filtered = filterAgentsForUser(allAgents, user);
    return filtered.map(agentToApiResponse);
  });
}
```

Response schema — array of:
```typescript
interface AgentApiResponse {
  id: string;           // directory name, e.g. "cre-analyst"
  name: string;         // display name, e.g. "CRE Analyst"
  description: string;  // from frontmatter or first paragraph
  icon?: string;        // emoji shortcode or null
  tags: string[];
  starters: string[];
}
```

Test:
```bash
curl -s -H "Authorization: Bearer abc-123-def" http://localhost:3000/api/agents | jq .
# [{ "id": "cre-analyst", "name": "CRE Analyst", ... }]

# Unauthorized
curl -s http://localhost:3000/api/agents
# 401 { "error": "Invalid or missing token" }

# Invalid token
curl -s -H "Authorization: Bearer wrong-token" http://localhost:3000/api/agents
# 401 { "error": "Invalid or missing token" }
```

---

**GET /api/agents/:id**

Returns a single agent's manifest. 404 if the agent doesn't exist or the user doesn't have access.

Response: same `AgentApiResponse` shape as the array element above.

Test:
```bash
curl -s -H "Authorization: Bearer abc-123-def" http://localhost:3000/api/agents/cre-analyst | jq .
# { "id": "cre-analyst", "name": "CRE Analyst", ... }

curl -s -H "Authorization: Bearer abc-123-def" http://localhost:3000/api/agents/nonexistent
# 404 { "error": "Agent not found" }

# Agent exists but user lacks access
curl -s -H "Authorization: Bearer limited-token" http://localhost:3000/api/agents/private-agent
# 403 { "error": "Access denied" }
```

---

**GET /api/sessions?agent=:agentId**

List sessions for an agent. The `agent` query parameter is required.

```typescript
app.get("/api/sessions", async (request, reply) => {
  const user = authenticateRequest(request, opts.access);
  if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

  const agentId = (request.query as any).agent;
  if (!agentId) return reply.code(400).send({ error: "agent query parameter required" });

  // Verify user has access to this agent
  const agentCtx = resolveAgentSafe(agentId);
  if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

  const sessionDirs = sessionDirsForUser(agentCtx, user);
  const sessions = await listSessions(sessionDirs);
  return sessions;
});
```

Response — array of:
```typescript
interface SessionApiResponse {
  id: string;           // SDK session UUID
  name: string;         // auto-generated from first message or user-renamed
  createdAt: string;    // ISO 8601
  lastUsedAt: string;   // ISO 8601
}
```

Test:
```bash
curl -s -H "Authorization: Bearer abc-123-def" \
  "http://localhost:3000/api/sessions?agent=cre-analyst" | jq .
# [{ "id": "abc-...", "name": "Analyze this deal", "createdAt": "...", "lastUsedAt": "..." }]

# Missing agent param
curl -s -H "Authorization: Bearer abc-123-def" http://localhost:3000/api/sessions
# 400 { "error": "agent query parameter required" }
```

---

**POST /api/sessions**

Create a new session record (pre-allocate before the first message). Body: `{ "agent": "cre-analyst" }`.

Returns the new session metadata. The `id` field will be used in WebSocket `subscribe` messages and in `resume` to continue the conversation. Note: the SDK assigns the actual session ID on the first `query()` call. This endpoint creates a placeholder; the real SDK session ID is captured from the `init` system message and back-patched.

```typescript
app.post("/api/sessions", async (request, reply) => {
  const user = authenticateRequest(request, opts.access);
  if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

  const { agent } = request.body as { agent: string };
  if (!agent) return reply.code(400).send({ error: "agent field required" });

  // Verify access
  const agentCtx = resolveAgentSafe(agent);
  if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

  const sessionDirs = sessionDirsForUser(agentCtx, user);
  // Create placeholder — real SDK session ID comes from first query
  const meta = createSessionMeta(crypto.randomUUID(), "(new conversation)");
  await saveSession(sessionDirs, meta);
  return reply.code(201).send(meta);
});
```

Test:
```bash
curl -s -X POST -H "Authorization: Bearer abc-123-def" \
  -H "Content-Type: application/json" \
  -d '{"agent":"cre-analyst"}' \
  http://localhost:3000/api/sessions | jq .
# { "id": "...", "name": "(new conversation)", "createdAt": "...", "lastUsedAt": "..." }
```

---

**DELETE /api/sessions/:id?agent=:agentId**

Delete a session. Does not delete the SDK's internal session data (those are in `~/.claude/`), only the harness metadata.

```typescript
app.delete("/api/sessions/:id", async (request, reply) => {
  const user = authenticateRequest(request, opts.access);
  if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

  const { id } = request.params as { id: string };
  const agentId = (request.query as any).agent;
  if (!agentId) return reply.code(400).send({ error: "agent query parameter required" });

  const agentCtx = resolveAgentSafe(agentId);
  if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

  const sessionDirs = sessionDirsForUser(agentCtx, user);
  // deleteSession not in sessions.ts yet — add it
  await deleteSession(sessionDirs, id);
  return { deleted: true };
});
```

This requires adding `deleteSession()` to `src/sessions.ts`:

```typescript
export async function deleteSession(dirs: SessionDirs, id: string): Promise<boolean> {
  try {
    await unlink(join(dirs.sessionsDir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
```

Test:
```bash
# Create then delete
SESSION_ID=$(curl -s -X POST -H "Authorization: Bearer abc-123-def" \
  -H "Content-Type: application/json" \
  -d '{"agent":"cre-analyst"}' \
  http://localhost:3000/api/sessions | jq -r .id)

curl -s -X DELETE -H "Authorization: Bearer abc-123-def" \
  "http://localhost:3000/api/sessions/$SESSION_ID?agent=cre-analyst" | jq .
# { "deleted": true }
```

---

### WebSocket endpoint: `/ws`

The WebSocket endpoint handles real-time bidirectional communication. One WebSocket connection per client. The client subscribes to an agent+session, sends messages, and receives a stream of typed frames.

#### WebSocket message type definitions

**File: `src/types/ws.ts`**

```typescript
// ─── Client → Server ───

export interface WsSubscribe {
  type: "subscribe";
  agentId: string;
  sessionId?: string;    // Omit for new conversation; provide to resume
  lastMessageId?: number; // For reconnection: replay messages after this ID
}

export interface WsMessage {
  type: "message";
  content: string;
}

export interface WsInterrupt {
  type: "interrupt";
}

export type WsClientMessage = WsSubscribe | WsMessage | WsInterrupt;

// ─── Server → Client ───

export interface WsConnected {
  type: "connected";
  connectionId: string;
}

export interface WsSubscribed {
  type: "subscribed";
  agentId: string;
  sessionId: string;     // The SDK session ID (may differ from the one sent)
  agentName: string;
  agentDescription: string;
}

export interface WsToken {
  type: "token";
  id: number;           // Monotonic message ID for reconnection
  text: string;
}

export interface WsThinkingToken {
  type: "thinking_token";
  text: string;
}

export interface WsToolUseStart {
  type: "tool_use_start";
  id: number;
  toolName: string;
  toolId: string;
}

export interface WsToolUseInput {
  type: "tool_use_input";
  toolId: string;
  partialJson: string;
}

export interface WsToolUseEnd {
  type: "tool_use_end";
  toolId: string;
  input: Record<string, unknown>;
}

export interface WsToolResult {
  type: "tool_result";
  id: number;
  toolId: string;
  content: string;      // Tool output text
}

export interface WsAssistantMessage {
  type: "assistant_message";
  id: number;
  content: string;       // Full text of the completed response
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export interface WsSubagentStarted {
  type: "subagent_started";
  taskId: string;
  description: string;
}

export interface WsSubagentProgress {
  type: "subagent_progress";
  taskId: string;
  toolUses: number;
  durationMs: number;
  totalTokens: number;
}

export interface WsSubagentDone {
  type: "subagent_done";
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  totalTokens: number;
}

export interface WsError {
  type: "error";
  code: string;          // Machine-readable: "auth_failed", "agent_not_found", "rate_limited", "internal"
  message: string;       // Human-readable
}

export interface WsStatus {
  type: "status";
  status: "thinking" | "responding" | "tool_use" | "idle" | "interrupted";
}

export interface WsResult {
  type: "result";
  sessionId: string;
  interrupted: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd?: number;
    durationMs?: number;
  };
}

export interface WsReplay {
  type: "replay";
  messages: WsServerMessage[];  // Buffered messages since lastMessageId
}

export type WsServerMessage =
  | WsConnected
  | WsSubscribed
  | WsToken
  | WsThinkingToken
  | WsToolUseStart
  | WsToolUseInput
  | WsToolUseEnd
  | WsToolResult
  | WsAssistantMessage
  | WsSubagentStarted
  | WsSubagentProgress
  | WsSubagentDone
  | WsError
  | WsStatus
  | WsResult
  | WsReplay;
```

#### WebSocket route registration

```typescript
function registerWebSocketRoute(app: FastifyInstance, opts: ServeOptions) {
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, request) => {
      const connectionId = crypto.randomUUID();
      const ws = socket;

      // Auth: read token from query param or Sec-WebSocket-Protocol header
      const token = extractWsToken(request);
      const user = token ? lookupUser(token, opts.access) : null;
      if (!user) {
        ws.send(JSON.stringify({ type: "error", code: "auth_failed", message: "Invalid token" }));
        ws.close(4001, "Unauthorized");
        return;
      }

      ws.send(JSON.stringify({ type: "connected", connectionId }));

      let activeConversation: ActiveConversation | null = null;

      ws.on("message", async (raw: Buffer) => {
        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
          return;
        }

        switch (msg.type) {
          case "subscribe":
            activeConversation = await handleSubscribe(ws, msg, user, opts);
            break;
          case "message":
            if (!activeConversation) {
              ws.send(JSON.stringify({ type: "error", code: "not_subscribed", message: "Subscribe first" }));
              return;
            }
            await handleMessage(ws, msg, activeConversation, opts);
            break;
          case "interrupt":
            if (activeConversation?.activeQuery) {
              await activeConversation.activeQuery.interrupt();
            }
            break;
        }
      });

      ws.on("close", () => {
        if (activeConversation?.activeQuery) {
          // Don't close the query — the session persists for reconnection
          activeConversation.activeQuery = null;
        }
      });
    });
  });
}
```

#### Stream adapter: SDK AsyncIterable to WebSocket frames

The core bridge. Takes the `Query` returned by `query()` and pumps typed frames to the WebSocket. This is the serve-mode equivalent of the `for await` loop in `App.tsx`'s `processMessage`.

```typescript
interface ActiveConversation {
  agentId: string;
  agentContext: AgentContext;
  sessionId: string | null;  // null until first SDK init message
  activeQuery: Query | null;
  messageBuffer: MessageBuffer;
  user: AccessUser;
}

async function handleMessage(
  ws: WebSocket,
  msg: WsMessage,
  conversation: ActiveConversation,
  opts: ServeOptions,
): Promise<void> {
  const { agentContext, user } = conversation;
  const config = opts.config;

  ws.send(JSON.stringify({ type: "status", status: "thinking" }));

  const systemPrompt = await buildSystemPrompt(agentContext);
  const cwd = agentContext.workspaceDir;  // or per-user workspace in Phase 4
  const agentEnv = loadAgentEnv(agentContext.agentDir);

  const options = buildOptions(
    agentContext,
    {
      resume: conversation.sessionId ?? undefined,
      systemPrompt,
      cwd,
      agentEnv,
    },
    config,
  );

  const q = sendMessage(msg.content, options);
  conversation.activeQuery = q;

  let responseBuffer = "";
  let wasInterrupted = false;

  try {
    for await (const sdkMsg of q) {
      // Capture session ID from init
      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "init" && sdkMsg.session_id) {
        conversation.sessionId = sdkMsg.session_id;
        // If this is a new session, save metadata
        const sessionDirs = sessionDirsForUser(agentContext, user);
        const meta = createSessionMeta(sdkMsg.session_id, msg.content);
        await saveSession(sessionDirs, meta);
      }

      // Stream events → WS frames
      if (sdkMsg.type === "stream_event") {
        const event = (sdkMsg as any).event;

        // Text tokens
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          responseBuffer += event.delta.text;
          const frame: WsToken = {
            type: "token",
            id: conversation.messageBuffer.nextId(),
            text: event.delta.text,
          };
          conversation.messageBuffer.push(frame);
          ws.send(JSON.stringify(frame));
        }

        // Thinking tokens
        if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
          ws.send(JSON.stringify({ type: "thinking_token", text: event.delta.thinking }));
        }

        // Tool use start
        if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
          const toolName = (event.content_block.name ?? "unknown").replace(/^mcp__.+?__/, "");
          const frame: WsToolUseStart = {
            type: "tool_use_start",
            id: conversation.messageBuffer.nextId(),
            toolName,
            toolId: event.content_block.id,
          };
          conversation.messageBuffer.push(frame);
          ws.send(JSON.stringify(frame));
          ws.send(JSON.stringify({ type: "status", status: "tool_use" }));
        }

        // Tool input streaming
        if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          ws.send(JSON.stringify({
            type: "tool_use_input",
            toolId: event.content_block?.id ?? "",
            partialJson: event.delta.partial_json,
          }));
        }

        // Tool use end
        if (event?.type === "content_block_stop" && event.content_block?.type === "tool_use") {
          ws.send(JSON.stringify({
            type: "tool_use_end",
            toolId: event.content_block.id,
            input: event.content_block.input ?? {},
          }));
          ws.send(JSON.stringify({ type: "status", status: "responding" }));
        }
      }

      // Sub-agent events
      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_started") {
        const m = sdkMsg as any;
        ws.send(JSON.stringify({
          type: "subagent_started", taskId: m.task_id, description: m.description ?? "",
        }));
      }

      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_progress") {
        const m = sdkMsg as any;
        ws.send(JSON.stringify({
          type: "subagent_progress",
          taskId: m.task_id,
          toolUses: m.usage?.tool_uses ?? 0,
          durationMs: m.usage?.duration_ms ?? 0,
          totalTokens: m.usage?.total_tokens ?? 0,
        }));
      }

      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_notification") {
        const m = sdkMsg as any;
        ws.send(JSON.stringify({
          type: "subagent_done",
          taskId: m.task_id,
          status: m.status,
          summary: m.summary ?? "",
          totalTokens: m.usage?.total_tokens ?? 0,
        }));
      }

      // Assistant complete message
      if (sdkMsg.type === "assistant") {
        const usage = (sdkMsg as any).message?.usage;
        if (!responseBuffer) {
          const text = (sdkMsg as any).message?.content
            ?.filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
          if (text) responseBuffer = text;
        }
        const frame: WsAssistantMessage = {
          type: "assistant_message",
          id: conversation.messageBuffer.nextId(),
          content: responseBuffer,
          usage: usage ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          } : undefined,
        };
        conversation.messageBuffer.push(frame);
        ws.send(JSON.stringify(frame));
      }

      // Result (end of turn)
      if (sdkMsg.type === "result") {
        wasInterrupted = !!(sdkMsg as any).is_interrupted;
      }
    }
  } catch (err) {
    const classified = classifyError(err);
    ws.send(JSON.stringify({
      type: "error",
      code: classified.category,
      message: classified.message,
    }));
  }

  conversation.activeQuery = null;

  // Final result frame
  ws.send(JSON.stringify({
    type: "result",
    sessionId: conversation.sessionId,
    interrupted: wasInterrupted,
    usage: {
      inputTokens: 0,   // Accumulated from stream events
      outputTokens: 0,
    },
  }));

  ws.send(JSON.stringify({ type: "status", status: "idle" }));

  // Touch session
  if (conversation.sessionId) {
    const sessionDirs = sessionDirsForUser(agentContext, conversation.user);
    await touchSession(sessionDirs, conversation.sessionId);
  }
}
```

#### Subscribe handler

```typescript
async function handleSubscribe(
  ws: WebSocket,
  msg: WsSubscribe,
  user: AccessUser,
  opts: ServeOptions,
): Promise<ActiveConversation | null> {
  // Verify agent access
  const allAgents = listAgents();
  const agent = allAgents.find(a => a.id === msg.agentId);
  if (!agent) {
    ws.send(JSON.stringify({ type: "error", code: "agent_not_found", message: `Agent "${msg.agentId}" not found` }));
    return null;
  }
  if (!userCanAccessAgent(agent, user)) {
    ws.send(JSON.stringify({ type: "error", code: "access_denied", message: "Access denied" }));
    return null;
  }

  const agentContext = resolveAgent(msg.agentId);
  const messageBuffer = new MessageBuffer(1000);  // Keep last 1000 frames

  const conversation: ActiveConversation = {
    agentId: msg.agentId,
    agentContext,
    sessionId: msg.sessionId ?? null,
    activeQuery: null,
    messageBuffer,
    user,
  };

  // Replay buffered messages if reconnecting
  if (msg.lastMessageId !== undefined && msg.sessionId) {
    const missed = messageBuffer.since(msg.lastMessageId);
    if (missed.length > 0) {
      ws.send(JSON.stringify({ type: "replay", messages: missed }));
    }
  }

  ws.send(JSON.stringify({
    type: "subscribed",
    agentId: msg.agentId,
    sessionId: msg.sessionId ?? "(new)",
    agentName: agent.name,
    agentDescription: agent.description,
  }));

  return conversation;
}
```

#### WebSocket auth extraction

Token can come from:
1. `Authorization` header (standard, but not always available in WebSocket)
2. `token` query parameter: `ws://host/ws?token=abc-123`
3. `Sec-WebSocket-Protocol` header with `token.` prefix

```typescript
function extractWsToken(request: FastifyRequest): string | null {
  // 1. Query parameter
  const queryToken = (request.query as any).token;
  if (queryToken) return queryToken;

  // 2. Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  // 3. Protocol header (for browsers that can't set custom headers on WS)
  const protocols = request.headers["sec-websocket-protocol"];
  if (protocols) {
    const parts = protocols.split(",").map(s => s.trim());
    const tokenProto = parts.find(p => p.startsWith("token."));
    if (tokenProto) return tokenProto.slice(6);
  }

  return null;
}
```

**Acceptance criteria:**

- `curl http://localhost:3000/health` returns 200 with JSON body
- `curl -H "Authorization: Bearer <valid>" http://localhost:3000/api/agents` returns filtered agent list
- `curl http://localhost:3000/api/agents` returns 401
- WebSocket at `/ws` accepts connections with valid token
- WebSocket rejects connections without valid token (close code 4001)
- Sending `subscribe` + `message` through WebSocket produces streaming `token` frames followed by `assistant_message` and `result`
- Sending `interrupt` stops generation and produces a `result` with `interrupted: true`
- Multiple concurrent WebSocket connections to different agents work independently

**Test plan:**

```bash
# Install wscat if not present
npm install -g wscat

# Start server
npx tsx bin/mastersof-ai.js --serve --port 3000 &

# Health check
curl -s http://localhost:3000/health | jq .

# List agents
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents | jq .

# WebSocket conversation
wscat -c "ws://localhost:3000/ws?token=$TOKEN"
# Once connected, send:
> {"type":"subscribe","agentId":"cofounder"}
# Expect: {"type":"subscribed","agentId":"cofounder","sessionId":"(new)","agentName":"Cofounder",...}

> {"type":"message","content":"What is 2+2?"}
# Expect: stream of {"type":"token",...} followed by {"type":"assistant_message",...} and {"type":"result",...}

# Interrupt test
> {"type":"message","content":"Write a very long essay about the history of mathematics"}
# Wait for tokens to start streaming, then:
> {"type":"interrupt"}
# Expect: {"type":"result","interrupted":true,...}

# Session resume
# Note the sessionId from the subscribed message, then reconnect:
wscat -c "ws://localhost:3000/ws?token=$TOKEN"
> {"type":"subscribe","agentId":"cofounder","sessionId":"<session-id-from-above>"}
> {"type":"message","content":"What did I ask you before?"}
# Agent should recall the previous conversation
```

---

## 2.2 Token Auth (`src/access.ts`)

**Requirement:** Load `access.yaml`, validate tokens on every request, filter agent roster by permissions.

**Current state:** No auth exists. All agents are accessible to the local user.

### File: `~/.mastersof-ai/access.yaml`

```yaml
tokens:
  abc-123-def:
    name: Jim
    agents: [cre-analyst]
  xyz-789-ghi:
    name: Dave
    agents: [cre-analyst, assistant]
  all-access-token:
    name: Chris
    agents: "*"
```

### File: `src/access.ts`

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getHomeDir } from "./config.js";

export interface AccessUser {
  token: string;
  name: string;
  agents: string[] | "*";  // "*" = all agents
}

export interface AccessConfig {
  users: Map<string, AccessUser>;  // Keyed by token
}

export function loadAccessConfig(): AccessConfig {
  const accessPath = join(getHomeDir(), "access.yaml");
  try {
    const raw = readFileSync(accessPath, "utf-8");
    const parsed = parse(raw) as { tokens?: Record<string, { name: string; agents: string[] | "*" }> };
    const users = new Map<string, AccessUser>();
    if (parsed?.tokens) {
      for (const [token, entry] of Object.entries(parsed.tokens)) {
        users.set(token, { token, name: entry.name, agents: entry.agents });
      }
    }
    return { users };
  } catch {
    // No access.yaml = no remote access allowed
    return { users: new Map() };
  }
}

export function lookupUser(token: string, access: AccessConfig): AccessUser | null {
  return access.users.get(token) ?? null;
}

export function authenticateRequest(request: { headers: Record<string, string | undefined> }, access: AccessConfig): AccessUser | null {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return lookupUser(token, access);
}

export function userCanAccessAgent(agent: AgentManifest, user: AccessUser): boolean {
  // Check token-level access
  if (user.agents !== "*" && !user.agents.includes(agent.id)) {
    return false;
  }

  // Check agent-level access (from IDENTITY.md frontmatter)
  if (agent.access === "private") {
    return false;  // Private agents are never visible to remote users
  }
  if (agent.access === "users") {
    return (agent.users ?? []).includes(user.name);
  }
  // access === "public" — visible to all authenticated users
  return true;
}

export function filterAgentsForUser(agents: AgentManifest[], user: AccessUser): AgentManifest[] {
  return agents.filter(a => userCanAccessAgent(a, user));
}
```

**Acceptance criteria:**

- Missing `access.yaml` results in zero users (server starts but all requests return 401)
- Valid token returns the user with correct name and agent list
- Invalid token returns null
- Wildcard `"*"` grants access to all public agents
- Agent with `access: "private"` is never returned to any remote user
- Agent with `access: "users"` is only returned to users in the `users` list AND whose token includes that agent
- Filtering is the intersection of token permissions AND agent access field

**Test plan:**

```bash
# Create access.yaml
cat > ~/.mastersof-ai/access.yaml << 'EOF'
tokens:
  test-token-123:
    name: TestUser
    agents: "*"
  limited-token:
    name: LimitedUser
    agents: [cofounder]
EOF

# Full access
curl -s -H "Authorization: Bearer test-token-123" http://localhost:3000/api/agents | jq '.[].id'
# Should list all public agents

# Limited access
curl -s -H "Authorization: Bearer limited-token" http://localhost:3000/api/agents | jq '.[].id'
# Should only list "cofounder"

# No token
curl -s http://localhost:3000/api/agents
# 401

# Invalid token
curl -s -H "Authorization: Bearer bogus" http://localhost:3000/api/agents
# 401
```

---

## 2.3 Session Management

**Requirement:** Map REST/WS session operations to the existing `sessions.ts` CRUD functions. Support SDK `resume` for continuing conversations.

**Current state:**

- `src/sessions.ts` has `saveSession`, `loadSession`, `listSessions`, `touchSession`, `renameSession`, `createSessionMeta`, `findSessionByName`
- Sessions are stored as individual JSON files: `~/.mastersof-ai/state/{agent}/sessions/{id}.json`
- The TUI passes `resume: sessionId` to `buildOptions()` to continue a conversation

**Changes:**

1. **Add `deleteSession()`** to `src/sessions.ts`:

```typescript
import { unlink } from "node:fs/promises";

export async function deleteSession(dirs: SessionDirs, id: string): Promise<boolean> {
  try {
    await unlink(join(dirs.sessionsDir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
```

2. **Per-user session directories** — In serve mode, each user gets isolated sessions to prevent one user from listing/resuming another's conversations:

```typescript
// In src/serve.ts (helper)
function sessionDirsForUser(ctx: AgentContext, user: AccessUser): SessionDirs {
  // For serve mode: sessions go under state/{agent}/sessions/{username}/
  const sessionsDir = join(ctx.stateDir, "sessions", user.name);
  const lastSessionFile = join(ctx.stateDir, `last-session-${user.name}`);
  return { sessionsDir, lastSessionFile };
}
```

This does NOT change the TUI's session paths. The TUI continues to use the existing `ctx.sessionsDir` (no user isolation needed for local use). Only the server-side helper uses per-user paths.

3. **SDK session resume** — When a WebSocket client sends `subscribe` with a `sessionId`, subsequent `query()` calls pass `resume: sessionId` in the options. This is already how the TUI works — the same `buildOptions()` function handles it.

**Session lifecycle:**

| Step | Trigger | Action |
|------|---------|--------|
| Create | `POST /api/sessions` or first message on new subscription | `createSessionMeta()` + `saveSession()` |
| Use | `message` over WS | `query()` with `resume: sessionId` |
| Touch | Each completed turn | `touchSession()` updates `lastUsedAt` |
| Rename | (future: REST endpoint or WS command) | `renameSession()` |
| Delete | `DELETE /api/sessions/:id` | `deleteSession()` |

**Acceptance criteria:**

- `POST /api/sessions` creates a session file on disk
- `GET /api/sessions?agent=X` lists only sessions belonging to the authenticated user
- `DELETE /api/sessions/:id` removes the session file
- WebSocket subscription with `sessionId` resumes the conversation (agent has memory of prior turns)
- Two users using the same agent have completely isolated session lists
- The TUI's session management is not affected by these changes

**Test plan:**

```bash
# Create session
SESSION=$(curl -s -X POST -H "Authorization: Bearer test-token-123" \
  -H "Content-Type: application/json" \
  -d '{"agent":"cofounder"}' \
  http://localhost:3000/api/sessions | jq -r .id)
echo "Created session: $SESSION"

# List sessions
curl -s -H "Authorization: Bearer test-token-123" \
  "http://localhost:3000/api/sessions?agent=cofounder" | jq .
# Should include the session we just created

# Verify different user sees different sessions
curl -s -H "Authorization: Bearer limited-token" \
  "http://localhost:3000/api/sessions?agent=cofounder" | jq .
# Should NOT include TestUser's session

# Delete session
curl -s -X DELETE -H "Authorization: Bearer test-token-123" \
  "http://localhost:3000/api/sessions/$SESSION?agent=cofounder" | jq .

# Verify it's gone
curl -s -H "Authorization: Bearer test-token-123" \
  "http://localhost:3000/api/sessions?agent=cofounder" | jq .
# Should not include the deleted session

# Resume via WebSocket
wscat -c "ws://localhost:3000/ws?token=test-token-123"
> {"type":"subscribe","agentId":"cofounder"}
> {"type":"message","content":"Remember the code word: BANANA"}
# Wait for response, note the sessionId from the subscribed/result message

# Disconnect and reconnect
wscat -c "ws://localhost:3000/ws?token=test-token-123"
> {"type":"subscribe","agentId":"cofounder","sessionId":"<noted-session-id>"}
> {"type":"message","content":"What was the code word?"}
# Agent should respond with BANANA
```

---

## 2.4 Message Buffer

**Requirement:** Server-side per-conversation buffer of recent WebSocket frames for reconnection replay.

**Current state:** No message buffering. If a WebSocket disconnects, all streamed data is lost.

### File: `src/message-buffer.ts`

```typescript
import type { WsServerMessage } from "./types/ws.js";

export class MessageBuffer {
  private buffer: Array<WsServerMessage & { id?: number }> = [];
  private maxSize: number;
  private counter = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /** Get the next monotonic message ID */
  nextId(): number {
    return ++this.counter;
  }

  /** Push a message into the buffer */
  push(msg: WsServerMessage & { id?: number }): void {
    this.buffer.push(msg);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /** Get all messages with id > afterId */
  since(afterId: number): WsServerMessage[] {
    return this.buffer.filter(
      (m) => m.id !== undefined && m.id > afterId
    );
  }

  /** Get the most recent message ID */
  lastId(): number {
    return this.counter;
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer = [];
  }
}
```

### Reconnection protocol

1. Client connects to `/ws` with token
2. Client sends `subscribe` with `agentId`, `sessionId`, and `lastMessageId`
3. Server looks up the conversation's `MessageBuffer`
4. If `lastMessageId` is provided and the buffer has messages after that ID:
   - Server sends a `replay` frame containing all missed messages
5. Client processes replayed messages as if they arrived normally
6. Subsequent messages arrive in real-time as usual

**Buffer storage:** Buffers are per-conversation, held in memory. They are NOT persisted to disk. If the server restarts, buffers are lost. This is acceptable — reconnection is for transient network drops, not server restarts. For server restarts, the client re-subscribes with the `sessionId` and the SDK `resume` mechanism handles conversation continuity.

**Buffer lifecycle:**
- Created when a conversation is subscribed
- Accumulates frames during message streaming (only frames with `id` field: `token`, `tool_use_start`, `tool_result`, `assistant_message`)
- Kept alive for 30 minutes after the last WebSocket disconnect
- Evicted after 30 minutes or when `maxSize` is reached (oldest messages dropped)

For buffer management across conversations, the server maintains a `Map<string, { buffer: MessageBuffer; lastActivity: number }>` keyed by `{agentId}:{sessionId}:{userName}`. A periodic sweep (every 5 minutes) evicts stale entries.

**Acceptance criteria:**

- Messages with `id` field are buffered
- `since(afterId)` returns only messages newer than the given ID
- Buffer respects `maxSize` (oldest messages evicted)
- Reconnection with `lastMessageId` replays missed messages
- Replay message ordering matches original send order
- Buffer is per-conversation, not shared across conversations

**Test plan:**

```bash
# Programmatic test with wscat (manual simulation)

# 1. Connect and start a conversation
wscat -c "ws://localhost:3000/ws?token=test-token-123"
> {"type":"subscribe","agentId":"cofounder"}
> {"type":"message","content":"Count from 1 to 20, one number per line, slowly"}
# Note the message IDs as tokens arrive
# Disconnect mid-stream (Ctrl+C)

# 2. Reconnect with lastMessageId
wscat -c "ws://localhost:3000/ws?token=test-token-123"
> {"type":"subscribe","agentId":"cofounder","sessionId":"<id>","lastMessageId":5}
# Should receive: {"type":"replay","messages":[...]} with all messages after ID 5
```

Unit test:

```typescript
import { MessageBuffer } from "./message-buffer.js";

// Test basic push and since
const buf = new MessageBuffer(100);
const id1 = buf.nextId(); // 1
buf.push({ type: "token", id: id1, text: "Hello" });
const id2 = buf.nextId(); // 2
buf.push({ type: "token", id: id2, text: " world" });

assert.deepEqual(buf.since(0), [
  { type: "token", id: 1, text: "Hello" },
  { type: "token", id: 2, text: " world" },
]);
assert.deepEqual(buf.since(1), [
  { type: "token", id: 2, text: " world" },
]);
assert.deepEqual(buf.since(2), []);

// Test max size eviction
const small = new MessageBuffer(2);
small.push({ type: "token", id: small.nextId(), text: "a" });
small.push({ type: "token", id: small.nextId(), text: "b" });
small.push({ type: "token", id: small.nextId(), text: "c" });
assert.equal(small.since(0).length, 2);  // Only "b" and "c"
```

---

## 2.5 Cost Tracking

**Requirement:** Track token usage per-session and per-user. Expose via REST endpoint.

**Current state:** The TUI displays context token count in the status bar but does not persist usage data. The SDK emits `usage` fields on `message_start`, `assistant`, and `result` stream events.

### File: `src/usage.ts`

```typescript
export interface SessionUsage {
  sessionId: string;
  agentId: string;
  userName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

export interface UsageSummary {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTurns: number;
  sessions: number;
  estimatedCostUsd: number;
}

// In-memory usage store. Persisted to disk on interval and shutdown.
export class UsageTracker {
  private sessions = new Map<string, SessionUsage>();

  /** Record a completed turn's usage */
  recordTurn(
    sessionId: string,
    agentId: string,
    userName: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): void {
    const key = sessionId;
    const existing = this.sessions.get(key);
    const now = new Date().toISOString();

    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
      existing.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      existing.turns += 1;
      existing.lastUsedAt = now;
    } else {
      this.sessions.set(key, {
        sessionId,
        agentId,
        userName,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        turns: 1,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    }
  }

  /** Get per-user summary */
  summarizeByUser(): UsageSummary[] {
    const byUser = new Map<string, UsageSummary>();

    for (const session of this.sessions.values()) {
      const existing = byUser.get(session.userName);
      if (existing) {
        existing.totalInputTokens += session.inputTokens;
        existing.totalOutputTokens += session.outputTokens;
        existing.totalCacheReadTokens += session.cacheReadTokens;
        existing.totalCacheCreationTokens += session.cacheCreationTokens;
        existing.totalTurns += session.turns;
        existing.sessions += 1;
      } else {
        byUser.set(session.userName, {
          user: session.userName,
          totalInputTokens: session.inputTokens,
          totalOutputTokens: session.outputTokens,
          totalCacheReadTokens: session.cacheReadTokens,
          totalCacheCreationTokens: session.cacheCreationTokens,
          totalTurns: session.turns,
          sessions: 1,
          estimatedCostUsd: 0,  // Calculated below
        });
      }
    }

    // Estimate costs (Opus 4.6 pricing as of 2026-03)
    // Input: $15/MTok, Output: $75/MTok, Cache read: $1.875/MTok, Cache write: $18.75/MTok
    for (const summary of byUser.values()) {
      summary.estimatedCostUsd =
        (summary.totalInputTokens / 1_000_000) * 15 +
        (summary.totalOutputTokens / 1_000_000) * 75 +
        (summary.totalCacheReadTokens / 1_000_000) * 1.875 +
        (summary.totalCacheCreationTokens / 1_000_000) * 18.75;
      summary.estimatedCostUsd = Math.round(summary.estimatedCostUsd * 100) / 100;
    }

    return Array.from(byUser.values());
  }

  /** Get all session usage records */
  allSessions(): SessionUsage[] {
    return Array.from(this.sessions.values());
  }
}
```

### Usage recording integration

In the WebSocket message handler (`handleMessage` in `src/serve.ts`), after processing the `result` message:

```typescript
// At end of the for-await loop, after processing "result" type
if (sdkMsg.type === "assistant") {
  const usage = (sdkMsg as any).message?.usage;
  if (usage) {
    accumulatedUsage.inputTokens += (usage.input_tokens ?? 0);
    accumulatedUsage.outputTokens += (usage.output_tokens ?? 0);
    accumulatedUsage.cacheReadTokens += (usage.cache_read_input_tokens ?? 0);
    accumulatedUsage.cacheCreationTokens += (usage.cache_creation_input_tokens ?? 0);
  }
}

// After the for-await loop completes:
usageTracker.recordTurn(
  conversation.sessionId!,
  conversation.agentId,
  conversation.user.name,
  accumulatedUsage,
);
```

### REST endpoint

**GET /api/usage**

Returns usage summaries. Only accessible to wildcard (`"*"`) token holders (operators).

```typescript
function registerUsageRoutes(app: FastifyInstance, opts: ServeOptions) {
  app.get("/api/usage", async (request, reply) => {
    const user = authenticateRequest(request, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    // Only operators (wildcard access) can view usage
    if (user.agents !== "*") {
      return reply.code(403).send({ error: "Usage data requires operator access" });
    }

    const summary = usageTracker.summarizeByUser();
    return {
      summary,
      sessions: usageTracker.allSessions(),
    };
  });
}
```

Response schema:
```json
{
  "summary": [
    {
      "user": "Jim",
      "totalInputTokens": 125000,
      "totalOutputTokens": 8500,
      "totalCacheReadTokens": 95000,
      "totalCacheCreationTokens": 30000,
      "totalTurns": 12,
      "sessions": 3,
      "estimatedCostUsd": 3.15
    }
  ],
  "sessions": [
    {
      "sessionId": "abc-...",
      "agentId": "cre-analyst",
      "userName": "Jim",
      "inputTokens": 45000,
      "outputTokens": 3200,
      "cacheReadTokens": 35000,
      "cacheCreationTokens": 10000,
      "turns": 5,
      "firstUsedAt": "2026-03-16T10:00:00.000Z",
      "lastUsedAt": "2026-03-16T10:15:00.000Z"
    }
  ]
}
```

**Acceptance criteria:**

- Every completed agent turn records input/output/cache token counts
- `GET /api/usage` returns per-user summary with estimated USD cost
- `GET /api/usage` returns per-session breakdown
- Non-operator tokens get 403 on `/api/usage`
- Cost estimates use correct Opus 4.6 pricing
- Usage data is in-memory only (acceptable for v1; persistence is Phase 4)

**Test plan:**

```bash
# Have a conversation first (via WebSocket as shown in 2.1 tests)

# Then check usage
curl -s -H "Authorization: Bearer test-token-123" http://localhost:3000/api/usage | jq .
# Should show usage for TestUser with non-zero token counts

# Limited user cannot see usage
curl -s -H "Authorization: Bearer limited-token" http://localhost:3000/api/usage
# 403 { "error": "Usage data requires operator access" }
```

---

## 2.6 `--serve` Flag in `src/index.tsx`

**Requirement:** Add `--serve` as a third execution mode alongside `--message` (headless) and default (TUI).

**Current state:** `src/index.tsx` has two branches:
1. `--message` flag: headless mode (line 188)
2. Default: TUI mode (line 227)

**Changes:**

Add a new branch before the `--message` check:

```typescript
// --- Flag: --serve (server mode) ---

if (getFlag("serve")) {
  const port = parseInt(getFlagValue("port") ?? "3000", 10);
  const host = getFlagValue("host") ?? "0.0.0.0";

  const { loadAccessConfig } = await import("./access.js");
  const { startServer } = await import("./serve.js");

  const access = loadAccessConfig();

  if (access.users.size === 0) {
    console.error("Warning: No tokens defined in ~/.mastersof-ai/access.yaml");
    console.error("All API requests will be rejected. Create access.yaml to enable access.");
    console.error("");
  }

  try {
    await startServer({ port, host, config, access });
    console.log(`Serve mode started on ${host}:${port}`);
  } catch (err) {
    console.error(formatError(err));
    process.exit(1);
  }

  // startServer blocks (Fastify listen keeps the process alive)
  // No need for explicit keep-alive
}
```

This goes at approximately line 100, after the auth check and before the agent resolution. In serve mode, agents are resolved per-request, not at startup. The global `process.chdir()` and agent env loading are skipped.

**Flow in serve mode:**

```
index.tsx
  ├── Parse args
  ├── First-run check
  ├── Load config
  ├── Auth check (Anthropic API key)
  ├── --serve? → startServer(port, host, config, access)
  │             └── Per-request: resolveAgent(), loadAgentEnv(), buildOptions(), query()
  ├── --message? → headless mode (unchanged)
  └── default → TUI mode (unchanged)
```

The `--serve` branch does NOT:
- Call `resolveAgent()` at startup (agents resolved per-request)
- Call `process.chdir()` (cwd is per-request)
- Call `loadAgentEnv()` at startup (env is per-request)
- Enter the sandbox gate (sandbox enforcement is per-request, Phase 4)

**Clean shutdown:**

```typescript
// In startServer()
const shutdown = async () => {
  console.log("Shutting down...");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

**Acceptance criteria:**

- `npx tsx bin/mastersof-ai.js --serve` starts a Fastify server on port 3000
- `npx tsx bin/mastersof-ai.js --serve --port 8080` uses port 8080
- `npx tsx bin/mastersof-ai.js --serve --host 127.0.0.1` binds only to localhost
- Server logs startup message to stdout
- Ctrl+C cleanly shuts down the server
- TUI mode (`npx tsx bin/mastersof-ai.js`) still works exactly as before
- Headless mode (`npx tsx bin/mastersof-ai.js --message "..."`) still works exactly as before
- `--serve` + `--message` is an error (mutually exclusive)

**Test plan:**

```bash
# Start server
npx tsx bin/mastersof-ai.js --serve --port 3000 &
SERVER_PID=$!

# Verify it's listening
curl -s http://localhost:3000/health | jq .
# { "status": "ok", ... }

# Verify TUI still works (separate terminal)
npx tsx bin/mastersof-ai.js --agent cofounder
# Should open TUI normally

# Verify headless still works
npx tsx bin/mastersof-ai.js --agent cofounder --message "Hello"
# Should print response and exit

# Clean shutdown
kill $SERVER_PID
# Should exit cleanly

# Verify custom port
npx tsx bin/mastersof-ai.js --serve --port 8080 &
curl -s http://localhost:8080/health | jq .
kill %1

# Verify localhost-only binding
npx tsx bin/mastersof-ai.js --serve --host 127.0.0.1 --port 3000 &
curl -s http://localhost:3000/health | jq .     # works
curl -s http://$(hostname -I | awk '{print $1}'):3000/health  # should fail
kill %1
```

---

## New Files Summary

| File | Purpose |
|------|---------|
| `src/serve.ts` | Fastify server, route registration, WebSocket handler, stream adapter |
| `src/access.ts` | Token auth, `access.yaml` loading, agent filtering |
| `src/message-buffer.ts` | Per-conversation message buffer for reconnection replay |
| `src/usage.ts` | Token usage tracking, cost estimation |
| `src/types/ws.ts` | WebSocket message type definitions (client and server) |

## Modified Files Summary

| File | Changes |
|------|---------|
| `src/index.tsx` | Remove `process.chdir()`, add `--serve` branch, try/catch around `resolveAgent()`/`createAgent()` |
| `src/agent.ts` | `buildOptions()` accepts `cwd` and `agentEnv` parameters |
| `src/agent-context.ts` | `resolveAgent()` throws instead of `process.exit()`, export error classes |
| `src/create-agent.ts` | `createAgent()` throws instead of `process.exit()`, export error class |
| `src/tools/index.ts` | `createAgentServers()` accepts `cwd` and `agentEnv` parameters |
| `src/tools/shell.ts` | `createShellTools()` accepts `agentEnv` parameter, merges into child env |
| `src/tools/web.ts` | `createWebTools()` accepts `agentEnv` parameter, reads `BRAVE_API_KEY` from it |
| `src/env.ts` | `loadAgentEnv()` stops mutating `process.env` |
| `src/sessions.ts` | Add `deleteSession()` function |
| `src/components/App.tsx` | Pass `cwd` and `agentEnv` through `buildOptions()` call |
| `package.json` | Add `fastify`, `@fastify/websocket`, `@fastify/cors` dependencies |

## Divergences from simple-chatapp Demo

| Aspect | simple-chatapp | Our implementation |
|--------|---------------|-------------------|
| Server framework | Express + raw `ws` | Fastify + `@fastify/websocket` |
| Query lifecycle | Long-lived `query()` with `MessageQueue` as async input | One `query()` per message with `resume` for continuity |
| Authentication | None | Token-based via `access.yaml` |
| Agent resolution | Single hardcoded agent | Per-request from IDENTITY.md roster |
| Message storage | In-memory `chatStore` | Existing `sessions.ts` file-based storage |
| Tool configuration | Hardcoded `allowedTools` array | Per-agent from IDENTITY.md frontmatter (Phase 1) |
| Streaming granularity | Coarse (`assistant_message` after full response) | Fine-grained (per-token, per-tool-use, per-subagent) |
| Session resume | Not supported | SDK `resume: sessionId` option |
| Reconnection | Not supported | Message buffer with `lastMessageId` replay |
| System prompt | Hardcoded constant | Per-agent IDENTITY.md + memory + date/workspace context |

The simple-chatapp's `MessageQueue` pattern (async iterable as prompt) is interesting for multi-turn conversations without reconnection overhead. However, it keeps a single SDK process alive per session, which doesn't match our model where `query()` is a clean per-turn call with `resume`. We may revisit this in Phase 4 if per-turn overhead becomes a problem, but for now the `resume` approach matches the TUI's proven model and gives us clean per-request error boundaries.

## Implementation Order

```
2.0a (process.chdir)  ─┐
2.0b (env scoping)     ├─► 2.1 (HTTP/WS server) ─► 2.4 (message buffer)
2.0c (error handling)  ─┘         │
                                  ├─► 2.2 (token auth)
                                  ├─► 2.3 (session management)
                                  ├─► 2.5 (cost tracking)
                                  └─► 2.6 (--serve flag)
```

2.0a/b/c can be done in parallel. They MUST all land before 2.1 begins.
2.2/2.3/2.4/2.5 can be developed in parallel once 2.1's skeleton is in place.
2.6 is the final integration — wires everything into the CLI entry point.
