# Partner Onboarding Guide

How to grant a partner (colleague, client, collaborator) access to your agents via the web UI.

## Prerequisites

- Harness running in serve mode (`mastersof-ai --serve`)
- Network access between you and the partner (Tailscale recommended — see [security-model.md](security-model.md))

## 1. Generate an Access Token

Generate a cryptographically random token using the Node.js REPL:

```bash
node -e "
const { randomBytes, createHash } = require('crypto');
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
console.log('Token (give to partner):', token);
console.log('Hash (store in access.yaml):', hash);
"
```

Or programmatically via the harness:

```typescript
import { generateAccessToken } from "./src/access.js";
const { token, tokenHash } = generateAccessToken();
```

**Important**: The raw token is shown once. The partner stores it; you store only the hash.

## 2. Add to access.yaml

Edit `~/.mastersof-ai/access.yaml`:

```yaml
users:
  # Existing users...

  - token_hash: "<paste the SHA-256 hash from step 1>"
    name: "partner-name"    # Unique identifier, no spaces
    agents:
      - billing             # List specific agents, or "*" for all
      - researcher
    budget:
      sessionLimit: 5.00    # USD per session
      dailyLimit: 25.00     # USD per day
      monthlyLimit: 200.00  # USD per month
    # tools_deny:           # Optional: restrict specific tools
    #   - shell_exec        # Prevent shell access
```

The file is hot-reloaded — no server restart needed.

## 3. Network Access (Tailscale)

For partners outside your LAN, use [Tailscale](https://tailscale.com) to create a private WireGuard mesh:

1. **Install Tailscale** on both the server and the partner's machine
2. **Invite the partner** to your tailnet (Tailscale admin console → Users → Invite)
3. **Start serve mode** with `--host 0.0.0.0`:
   ```bash
   mastersof-ai --serve --host 0.0.0.0 --port 3200
   ```
4. **Partner connects** via your Tailscale IP:
   ```
   https://<your-tailscale-hostname>:3200
   ```

### Tailscale ACLs (recommended)

Restrict which partners can reach the harness port:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:partner"],
      "dst": ["tag:harness:3200"]
    }
  ]
}
```

## 4. Partner Setup

Give your partner:

1. **The raw access token** (from step 1)
2. **The server URL** (Tailscale hostname + port, or LAN IP)
3. **Assigned agent names** (so they know what's available)

The partner opens the web UI in their browser and enters the token when prompted.

## What Partners Can Do

- Chat with assigned agents via the web UI
- View their own session history
- Use tools the agent provides (subject to tool deny lists)

## What Partners Cannot Do

- Access agents not in their `agents` list
- Use tools in their `tools_deny` list
- Exceed their budget limits (session, daily, monthly)
- Access other users' sessions, workspaces, or memory
- Execute shell commands (unless explicitly allowed in agent manifest + sandbox config)
- Use command-based MCP servers (blocked in serve mode)

## Security Model

Each partner session runs in an isolated worker process (W5-T02):

- **Process isolation**: Separate Node.js process per conversation — crash in one doesn't affect others
- **Env isolation**: Worker process.env contains only safe base vars + agent credentials (no ANTHROPIC_API_KEY leakage)
- **Directory isolation**: Per-user workspace, memory, logs, and proposals directories (0o700 permissions)
- **Query serialization**: Concurrent messages from the same user are serialized by a mutex (W5-T06)

For the full security model, see [security-model.md](security-model.md).

## Revoking Access

1. Remove the user's entry from `~/.mastersof-ai/access.yaml`
2. The file watcher detects the change and disconnects active sessions with revoked tokens
3. No server restart needed

## Budget Management

Monitor usage via the REST API:

```bash
# As admin (agents: "*")
curl -H "Authorization: Bearer <admin-token>" http://localhost:3200/api/usage
```

Reset a user's budget:

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"scope": "daily"}' \
  http://localhost:3200/api/admin/users/partner-name/budget/reset
```

Valid scopes: `session`, `daily`, `monthly`, `all`.
