import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentCard } from "@a2a-js/sdk";
import { AgentCardResolver, ClientFactory } from "@a2a-js/sdk/client";
import type { HarnessConfig } from "../config.js";

export function createA2ATools(config: HarnessConfig) {
  // In-memory agent card cache for the session
  const cardCache = new Map<string, AgentCard>();
  const clientFactory = new ClientFactory();
  const registeredAgents = config.a2a.agents;

  // Resolve name or URL to a URL
  function resolveUrl(nameOrUrl: string): string {
    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
      return nameOrUrl;
    }
    const entry = registeredAgents[nameOrUrl];
    if (!entry) {
      throw new Error(
        `Unknown agent "${nameOrUrl}". Use a full URL or register it in config.yaml under a2a.agents.`,
      );
    }
    return entry.url;
  }

  const a2aList = tool(
    "a2a_list",
    "List all registered A2A agents from config. Returns name, URL, and description for each.",
    {},
    async () => {
      const entries = Object.entries(registeredAgents);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No A2A agents registered. Add them to config.yaml under a2a.agents.",
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
        const cached = cardCache.get(resolved);
        if (cached) {
          return { content: [{ type: "text" as const, text: JSON.stringify(cached, null, 2) }] };
        }

        const card = await AgentCardResolver.default.resolve(resolved);
        cardCache.set(resolved, card);
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
        return { content: [{ type: "text" as const, text: `A2A call to ${url} failed: ${err}` }] };
      }
    },
  );

  return [a2aList, a2aDiscover, a2aCall];
}
