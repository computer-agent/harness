import { randomUUID } from "node:crypto";
import type { AgentCard } from "@a2a-js/sdk";
import { AgentCardResolver, ClientFactory } from "@a2a-js/sdk/client";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { A2AAgentEntry } from "../config.js";
import type { EgressFilter } from "../egress-proxy.js";
import { validateUrl } from "../url-safety.js";

const MAX_CARD_CACHE = 50;

export function createA2ATools(agents: Record<string, A2AAgentEntry>, egressFilter?: EgressFilter) {
  const cardCache = new Map<string, AgentCard>();
  const clientFactory = new ClientFactory();

  function cacheCard(url: string, card: AgentCard) {
    if (cardCache.size >= MAX_CARD_CACHE) {
      const oldest = cardCache.keys().next().value;
      if (oldest) cardCache.delete(oldest);
    }
    cardCache.set(url, card);
  }

  // Set of pre-registered agent URLs (trusted — skip SSRF validation)
  const registeredUrls = new Set(Object.values(agents).map((a) => a.url));

  // Resolve name or URL to a URL
  function resolveUrl(nameOrUrl: string): string {
    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
      return nameOrUrl;
    }
    const entry = agents[nameOrUrl];
    if (!entry) {
      throw new Error(
        `Unknown agent "${nameOrUrl}". Use a full URL or register it in config.yaml under tools.a2a.agents.`,
      );
    }
    return entry.url;
  }

  /**
   * Validate a resolved URL for SSRF unless it's a pre-registered agent URL.
   * Registered URLs are configured by the operator in config.yaml and are trusted.
   * Also enforces egress domain allowlist when configured.
   */
  async function validateA2AUrl(resolved: string): Promise<void> {
    if (registeredUrls.has(resolved)) {
      // Registered URLs bypass SSRF check but still must pass egress filter
      if (egressFilter) egressFilter.validate(resolved);
      return;
    }
    await validateUrl(resolved);
    if (egressFilter) egressFilter.validate(resolved);
  }

  const a2aList = tool(
    "a2a_list",
    "List all registered A2A agents from config. Returns name, URL, and description for each.",
    {},
    async () => {
      const entries = Object.entries(agents);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No A2A agents registered. Add them to config.yaml under tools.a2a.agents.",
            },
          ],
        };
      }
      const lines = entries.map(([name, { url, description }]) => `- ${name}: ${url} — ${description}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  const a2aDiscover = tool(
    "a2a_discover",
    "Discover a remote A2A agent by fetching its Agent Card. Returns the agent's name, description, skills, and capabilities.",
    {
      url: z.string().describe("Base URL of the remote A2A agent, or a registered agent name"),
    },
    async ({ url }) => {
      try {
        const resolved = resolveUrl(url);
        await validateA2AUrl(resolved);

        const cached = cardCache.get(resolved);
        if (cached) {
          return { content: [{ type: "text" as const, text: JSON.stringify(cached, null, 2) }] };
        }

        const card = await AgentCardResolver.default.resolve(resolved);
        cacheCard(resolved, card);
        return { content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to discover agent at ${url}: ${err}` }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const a2aCall = tool(
    "a2a_call",
    "Send a message to a remote A2A agent and get a response. Accepts a URL or a registered agent name.",
    {
      url: z.string().describe("Base URL of the remote A2A agent, or a registered agent name"),
      message: z.string().describe("Message to send to the remote agent"),
    },
    async ({ url, message }) => {
      try {
        const resolved = resolveUrl(url);
        await validateA2AUrl(resolved);
        const client = await clientFactory.createFromUrl(resolved);
        const result = await client.sendMessage({
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: message }],
          },
        });

        // Result can be a Message (direct response) or Task (async)
        if (result.kind === "message") {
          const textParts = result.parts
            .filter((p: { kind: string }) => p.kind === "text")
            .map((p: { kind: string; text?: string }) => p.text ?? "")
            .join("\n");
          return { content: [{ type: "text" as const, text: textParts || "(empty response)" }] };
        }

        // Task response — extract status message
        if (result.kind === "task") {
          const status = result.status;
          if (status?.message) {
            const textParts = status.message.parts
              .filter((p: { kind: string }) => p.kind === "text")
              .map((p: { kind: string; text?: string }) => p.text ?? "")
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Task ${result.id} (${status.state}):\n${textParts}`,
                },
              ],
            };
          }
          return {
            content: [{ type: "text" as const, text: `Task ${result.id} state: ${status?.state ?? "unknown"}` }],
          };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `A2A call failed: ${err}` }] };
      }
    },
  );

  return [a2aList, a2aDiscover, a2aCall];
}
