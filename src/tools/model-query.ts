import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

function resolveModel(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}

type ThinkingLevel = "disabled" | "low" | "medium" | "high" | "max";

const EFFORT_MAP: Record<Exclude<ThinkingLevel, "disabled">, "low" | "medium" | "high" | "max"> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

function extractTextFromContent(content: any[]): { text: string; thinkingTokenEstimate: number } {
  const textParts: string[] = [];
  let thinkingChars = 0;

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "thinking" && block.thinking) {
      thinkingChars += block.thinking.length;
    }
  }

  // Rough estimate: ~4 chars per token for thinking
  return { text: textParts.join(""), thinkingTokenEstimate: Math.round(thinkingChars / 4) };
}

function formatUsage(inputTokens: number, outputTokens: number, thinkingTokens?: number): string {
  let s = `${inputTokens} in / ${outputTokens} out`;
  if (thinkingTokens && thinkingTokens > 0) s += ` (${thinkingTokens} thinking)`;
  return s;
}

async function queryModel(opts: {
  model: string;
  systemPrompt?: string;
  message: string;
  thinking: ThinkingLevel;
}): Promise<{ text: string; usage: string }> {
  let responseText = "";
  let usageInfo = "";

  const queryOptions: Parameters<typeof query>[0]["options"] = {
    model: opts.model,
    systemPrompt: opts.systemPrompt ?? "You are a helpful assistant.",
    tools: [],
    mcpServers: {},
    maxTurns: 1,
    persistSession: false,
  };

  if (opts.thinking === "disabled") {
    queryOptions.thinking = { type: "disabled" };
  } else {
    queryOptions.thinking = { type: "adaptive" };
    queryOptions.effort = EFFORT_MAP[opts.thinking];
  }

  for await (const msg of query({
    prompt: opts.message,
    options: queryOptions,
  })) {
    if (msg.type === "assistant") {
      // SDKAssistantMessage.message is a BetaMessage with .content array
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        const extracted = extractTextFromContent(content);
        if (extracted.text) responseText = extracted.text;
      }
      const u = (msg as any).message?.usage;
      if (u) {
        usageInfo = formatUsage(u.input_tokens ?? 0, u.output_tokens ?? 0);
      }
    }
    // result is authoritative for text — matches web.ts pattern
    if ("result" in msg && typeof (msg as any).result === "string") {
      const resultStr = (msg as any).result;
      if (resultStr) responseText = resultStr;
    }
    if (msg.type === "result") {
      // Prefer modelUsage from result for accurate totals
      const mu = (msg as any).modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }> | undefined;
      if (mu) {
        let totalIn = 0;
        let totalOut = 0;
        for (const m of Object.values(mu)) {
          totalIn += m.inputTokens ?? 0;
          totalOut += m.outputTokens ?? 0;
        }
        usageInfo = formatUsage(totalIn, totalOut);
      }
    }
  }

  return { text: responseText || "(no response)", usage: usageInfo || "unknown" };
}

const modelQuery = tool(
  "model_query",
  'Send a one-shot query to a specific Claude model. No tools — just raw model response. Use for: cross-model comparisons, evaluations, quick questions to a specific model. Do NOT use for research or tasks requiring web/file access — use sub-agents instead. Aliases: "haiku", "sonnet", "opus".',
  {
    model: z.string().describe('Model ID or alias: "haiku", "sonnet", "opus", or full ID like "claude-haiku-4-5"'),
    message: z.string().describe("The user message to send"),
    system_prompt: z.string().optional().describe("System prompt for this query"),
    thinking: z
      .enum(["disabled", "low", "medium", "high", "max"])
      .optional()
      .describe("Thinking effort level. Default: 'disabled'. Uses adaptive thinking with the specified effort."),
  },
  async ({ model, message, system_prompt, thinking }) => {
    const resolvedModel = resolveModel(model);
    const thinkingLevel: ThinkingLevel = thinking ?? "disabled";

    try {
      const { text, usage } = await queryModel({
        model: resolvedModel,
        systemPrompt: system_prompt,
        message,
        thinking: thinkingLevel,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `[${resolvedModel}] (${usage})\n\n${text}`,
          },
        ],
      };
    } catch (err: unknown) {
      const e = err as { message: string };
      return {
        content: [{ type: "text" as const, text: `Error: ${e.message}` }],
      };
    }
  },
);

export const modelQueryTools = [modelQuery];
