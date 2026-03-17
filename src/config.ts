import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export interface HarnessConfig {
  model: string;
  defaultAgent: string;
  tools: {
    memory: { enabled: boolean };
    workspace: { enabled: boolean };
    web: { enabled: boolean; extraction_model?: string };
    shell: { enabled: boolean };
    tasks: { enabled: boolean };
    introspection: { enabled: boolean };
    models: { enabled: boolean };
    scratchpad: { enabled: boolean };
    a2a: { enabled: boolean };
  };
  hooks: {
    logToolUse: boolean;
    verifyBeforeComplete: boolean;
    loopDetection: boolean;
    loopDetectionThreshold: number;
    compactSuccessOutput: boolean;
    compactOutputThreshold: number;
  };
  effort: "low" | "medium" | "high" | "max";
  a2a: {
    enabled: boolean;
    port: number;
    agents: Record<string, { url: string; description: string }>;
  };
}

const DEFAULTS: HarnessConfig = {
  model: "claude-opus-4-6[1m]",
  defaultAgent: "cofounder",
  tools: {
    memory: { enabled: true },
    workspace: { enabled: true },
    web: { enabled: true },
    shell: { enabled: true },
    tasks: { enabled: true },
    introspection: { enabled: true },
    models: { enabled: true },
    scratchpad: { enabled: true },
    a2a: { enabled: true },
  },
  hooks: {
    logToolUse: false,
    verifyBeforeComplete: true,
    loopDetection: true,
    loopDetectionThreshold: 3,
    compactSuccessOutput: true,
    compactOutputThreshold: 50,
  },
  effort: "max",
  a2a: {
    enabled: true,
    port: 4000,
    agents: {},
  },
};

export function getHomeDir(): string {
  return join(homedir(), ".mastersof-ai");
}

export function getConfigPath(): string {
  return join(getHomeDir(), "config.yaml");
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(): HarnessConfig {
  const configPath = getConfigPath();
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    return deepMerge(DEFAULTS, parsed);
  } catch {
    return DEFAULTS;
  }
}

export const DEFAULT_CONFIG_YAML = `# Masters of AI Harness — Configuration
# See: https://mastersof.ai/docs/config

# Default model for all agents (append [1m] for 1M context window)
model: claude-opus-4-6[1m]

# Agent to start when no --agent flag is given
defaultAgent: cofounder

# Effort level: low | medium | high | max
# Controls how much thinking/reasoning effort the model applies
effort: max

# Tool domains — disable any you don't need
tools:
  memory:
    enabled: true
  workspace:
    enabled: true
  web:
    enabled: true
    # extraction_model: claude-haiku-4-5  # Enables smart extraction for web_fetch
  shell:
    enabled: true
  tasks:
    enabled: true
  introspection:
    enabled: true
  models:
    enabled: true

# Hooks — lifecycle callbacks for the agent SDK
hooks:
  # Log every tool call to stderr log (tool name, inputs, timing)
  logToolUse: false
  # Remind agent to verify file changes before completing a task
  verifyBeforeComplete: true
  # Detect and warn about repeated edits to the same file
  loopDetection: true
  loopDetectionThreshold: 3
  # Truncate long successful command output, preserve full failure output
  compactSuccessOutput: true
  compactOutputThreshold: 50

# A2A protocol configuration
a2a:
  enabled: true
  port: 4000         # default port for --serve mode
  agents: {}         # registered remote A2A agents
  # Example:
  #   data-pipeline:
  #     url: http://data-agent.internal:4000
  #     description: "LangGraph data pipeline agent"
`;
