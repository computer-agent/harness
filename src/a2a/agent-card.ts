import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  const paragraphs: string[] = [];
  let current = "";

  for (const line of lines) {
    if (line.startsWith("#") && !current) continue;
    if (line.trim() === "" && current) {
      paragraphs.push(current.trim());
      current = "";
    } else if (!line.startsWith("#")) {
      current += ` ${line}`;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs[0] ?? "An AI agent";
}

function deriveSkillsFromIdentity(identity: string): AgentSkill[] {
  const skills: AgentSkill[] = [];
  const lines = identity.split("\n");
  let currentH2 = "";
  let currentBody = "";

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentH2 && currentBody.trim()) {
        skills.push({
          id: currentH2.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
          name: currentH2,
          description: currentBody.trim().slice(0, 500),
          tags: [],
        });
      }
      currentH2 = line.slice(3).trim();
      currentBody = "";
    } else if (currentH2 && !line.startsWith("#")) {
      currentBody += ` ${line}`;
    }
  }

  if (currentH2 && currentBody.trim()) {
    skills.push({
      id: currentH2.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
      name: currentH2,
      description: currentBody.trim().slice(0, 500),
      tags: [],
    });
  }

  // If no H2 sections, create a single default skill
  if (skills.length === 0) {
    skills.push({
      id: "general",
      name: "General",
      description: extractFirstParagraph(identity),
      tags: [],
    });
  }

  return skills;
}

export function buildAgentCard(
  agentName: string,
  identity: string,
  opts: { url?: string; port?: number } = {},
): AgentCard {
  const port = opts.port ?? 4000;
  const url = opts.url ?? `http://localhost:${port}/`;

  return {
    name: agentName,
    description: extractFirstParagraph(identity),
    version: getPackageVersion(),
    url,
    protocolVersion: "0.3.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: deriveSkillsFromIdentity(identity),
  };
}
