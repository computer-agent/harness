import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { z } from "zod";
import type { EgressFilter } from "../egress-proxy.js";
import { validateUrl } from "../url-safety.js";

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function createVirtualConsole(): VirtualConsole {
  const vc = new VirtualConsole();
  vc.on("error", (err: string) => {
    if (typeof err === "string" && err.includes("Could not parse CSS stylesheet")) return;
    console.error(err);
  });
  return vc;
}

async function extractRelevantContent(markdown: string, userQuery: string, model: string): Promise<string> {
  let resultText = "";
  for await (const msg of sdkQuery({
    prompt: `Extract only the content relevant to the following query. Return clean markdown. If nothing is relevant, say "No relevant content found."\n\nQuery: ${userQuery}\n\nContent:\n${markdown}`,
    options: {
      model,
      systemPrompt:
        "You are a precise content extractor. Return only content directly relevant to the user's query. Preserve original formatting. Be aggressive about cutting irrelevant content. Do not add commentary.",
      tools: [],
      mcpServers: {},
      maxTurns: 1,
      persistSession: false,
    },
  })) {
    if ("result" in msg && typeof (msg as any).result === "string") {
      resultText = (msg as any).result;
    }
  }
  return resultText || markdown;
}

export function createWebTools(
  webConfig?: { extraction_model?: string },
  agentEnv: Record<string, string> = {},
  egressFilter?: EgressFilter,
) {
  const extractionModel = webConfig?.extraction_model;

  const webSearch = tool(
    "web_search",
    "Search the web for current information — markets, competitors, trends, news, research. Returns top results with titles, URLs, and descriptions.",
    {
      query: z.string().describe("Search query"),
      count: z.number().optional().describe("Number of results to return (default 5, max 20)"),
    },
    async ({ query, count = 5 }) => {
      const apiKey = agentEnv.BRAVE_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text" as const, text: "BRAVE_API_KEY not set. Cannot perform web search." }],
        };
      }

      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(count, 20)));

      // Egress filter: check domain allowlist (when configured)
      if (egressFilter) {
        try {
          egressFilter.validate(url.toString());
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
      }

      const res = await fetch(url.toString(), {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      });

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${res.status} ${res.statusText}` }],
        };
      }

      const data = (await res.json()) as {
        web?: { results?: Array<{ title: string; url: string; description: string }> };
      };
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results found for: ${query}` }] };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
        .join("\n\n");

      return { content: [{ type: "text" as const, text: formatted }] };
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const webFetch = tool(
    "web_fetch",
    "Fetch a URL and extract its content as clean markdown. Strips navigation, ads, and chrome. Optionally pass a query to extract only relevant content, dramatically reducing token usage.",
    {
      url: z.string().url().describe("URL to fetch"),
      query: z
        .string()
        .optional()
        .describe(
          "If provided, content is filtered through an LLM to return only portions relevant to this query. Dramatically reduces returned tokens.",
        ),
    },
    async ({ url, query }) => {
      try {
        await validateUrl(url);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }] };
      }

      // Egress filter: check domain allowlist (when configured)
      if (egressFilter) {
        try {
          egressFilter.validate(url);
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: err.message }] };
        }
      }

      const res = await fetch(url, {
        headers: {
          "User-Agent": `MastersOfAI-Harness/${PKG_VERSION}`,
        },
      });

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Fetch failed: ${res.status} ${res.statusText}` }],
        };
      }

      const html = await res.text();
      const dom = new JSDOM(html, { url, virtualConsole: createVirtualConsole() });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      let markdown: string;
      if (article?.content) {
        markdown = `# ${article.title}\n\n${turndown.turndown(article.content)}`;
      } else {
        markdown = turndown.turndown(html);
      }

      // Truncate to ~50k chars to avoid overwhelming context
      const wasTruncated = markdown.length > 50000;
      if (wasTruncated) {
        markdown = `${markdown.slice(0, 50000)}\n\n---\n*[Content truncated at 50,000 characters]*`;
      }

      const stats: string[] = [];
      const rawChars = markdown.length;

      if (query && extractionModel) {
        markdown = await extractRelevantContent(markdown, query, extractionModel);
        const extractedChars = markdown.length;
        const savedPct = Math.round((1 - extractedChars / rawChars) * 100);
        stats.push(
          `Extracted ${extractedChars.toLocaleString()} chars from ${rawChars.toLocaleString()} (${savedPct}% reduction, ~${Math.round((rawChars - extractedChars) / 4).toLocaleString()} tokens saved)`,
        );
      } else {
        stats.push(`${rawChars.toLocaleString()} chars${wasTruncated ? " (truncated)" : ""}`);
      }

      const footer = `\n\n---\n*[${stats.join(" · ")}]*`;
      return { content: [{ type: "text" as const, text: markdown + footer }] };
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  return [webSearch, webFetch];
}
