import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Tool domain names (must match keys in HarnessConfig.tools) ---

export const TOOL_DOMAINS = ["memory", "workspace", "web", "shell", "tasks", "introspection", "models"] as const;

export type ToolDomain = (typeof TOOL_DOMAINS)[number];

// --- Zod schema ---

const ToolFilterSchema = z
  .object({
    allow: z.array(z.enum(TOOL_DOMAINS)).optional(),
    deny: z.array(z.enum(TOOL_DOMAINS)).optional(),
  })
  .refine((val) => !(val.allow && val.deny), {
    message: "tools.allow and tools.deny are mutually exclusive",
  });

const McpServerSchema = z
  .object({
    server: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i, "Server name must be alphanumeric with hyphens"),
    uri: z.string().url().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine((val) => (val.uri ? !val.command : !!val.command), {
    message: "Exactly one of uri or command must be specified",
  });

export type McpServerManifest = z.infer<typeof McpServerSchema>;

const SandboxSchema = z.object({
  enforce: z.boolean().optional(),
  network: z.enum(["host", "none"]).optional(),
  mounts: z
    .array(
      z.object({
        path: z.string(),
        mode: z.enum(["ro", "rw"]).default("ro"),
      }),
    )
    .optional(),
});

const SubAgentSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  tools: ToolFilterSchema.optional(),
});

export const AgentFrontmatterSchema = z.object({
  // Display
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).default([]),
  starters: z.array(z.string()).default([]),

  // Tools
  tools: ToolFilterSchema.optional(),
  mcp: z.array(McpServerSchema).default([]),

  // Model
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),

  // Access
  access: z.enum(["public", "private", "users"]).default("public"),
  users: z.array(z.string()).default([]),

  // Sandbox
  sandbox: SandboxSchema.optional(),

  // Sub-agents
  agents: z.record(z.string(), SubAgentSchema).optional(),
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface AgentManifest {
  /** Directory name (the agent ID used on CLI) */
  id: string;
  /** Display name: frontmatter.name ?? capitalize(id) */
  displayName: string;
  /** Description: frontmatter.description ?? first paragraph of body ?? "" */
  description: string;
  /** Absolute path to the agent directory */
  agentDir: string;
  /** Parsed and validated frontmatter (all defaults applied) */
  frontmatter: AgentFrontmatter;
  /** Markdown body (everything after the closing ---), used as system prompt */
  body: string;
}

// --- Frontmatter parser ---

export interface ParsedIdentity {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Split YAML frontmatter from markdown body.
 *
 * Rules:
 * - Frontmatter must start at the very first character of the file with `---\n`
 * - Frontmatter ends at the next `\n---\n` (or `\n---` at EOF)
 * - If no valid frontmatter delimiters are found, the entire content is the body
 */
export function parseFrontmatter(raw: string): ParsedIdentity {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontmatter: null, body: raw };
  }

  // Find the closing delimiter (must be on its own line)
  const closingIndex = raw.indexOf("\n---\n", 4);
  const closingIndexEof = raw.indexOf("\n---", 4);

  let yamlEnd: number;
  let bodyStart: number;

  if (closingIndex !== -1) {
    yamlEnd = closingIndex;
    bodyStart = closingIndex + 5; // skip \n---\n
  } else if (closingIndexEof !== -1 && closingIndexEof + 4 >= raw.length) {
    // --- at end of file with nothing after
    yamlEnd = closingIndexEof;
    bodyStart = raw.length;
  } else {
    // No closing delimiter found — treat entire file as body
    return { frontmatter: null, body: raw };
  }

  const yamlStr = raw.slice(4, yamlEnd); // skip opening ---\n
  try {
    const parsed = parseYaml(yamlStr);
    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return { frontmatter: null, body: raw };
    }
    return {
      frontmatter: parsed as Record<string, unknown>,
      body: bodyStart < raw.length ? raw.slice(bodyStart).replace(/^\n+/, "") : "",
    };
  } catch {
    // YAML parse error — treat as no frontmatter
    return { frontmatter: null, body: raw };
  }
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip leading headings and blank lines
    if (!started) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      started = true;
    }
    if (started) {
      if (trimmed === "") break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(" ");
}

// --- Manifest loader ---

export interface ManifestWarning {
  agentDir: string;
  message: string;
}

export interface ManifestResult {
  manifest: AgentManifest;
  warnings: ManifestWarning[];
}

/**
 * Load and validate an AgentManifest from an agent directory.
 *
 * @param agentDir - Absolute path to the agent directory (e.g. ~/.mastersof-ai/agents/analyst)
 * @returns ManifestResult with the manifest and any validation warnings
 * @throws Error if IDENTITY.md does not exist or cannot be read
 */
export async function loadAgentManifest(agentDir: string): Promise<ManifestResult> {
  const id = basename(agentDir);
  const identityPath = join(agentDir, "IDENTITY.md");
  const warnings: ManifestWarning[] = [];

  const raw = await readFile(identityPath, "utf-8");
  const { frontmatter: rawFrontmatter, body } = parseFrontmatter(raw);

  let frontmatter: AgentFrontmatter;

  if (rawFrontmatter === null) {
    // No frontmatter — all defaults
    frontmatter = AgentFrontmatterSchema.parse({});
  } else {
    const result = AgentFrontmatterSchema.safeParse(rawFrontmatter);
    if (result.success) {
      frontmatter = result.data;
    } else {
      warnings.push({
        agentDir,
        message: `Frontmatter validation failed: ${result.error.issues.map((i) => i.message).join("; ")}. Using defaults.`,
      });
      frontmatter = AgentFrontmatterSchema.parse({});
    }
  }

  const displayName = frontmatter.name ?? capitalize(id);
  const description = frontmatter.description ?? extractFirstParagraph(body);

  return {
    manifest: {
      id,
      displayName,
      description,
      agentDir,
      frontmatter,
      body,
    },
    warnings,
  };
}
