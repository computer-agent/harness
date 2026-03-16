import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "./manifest.js";

/**
 * Load the system prompt from an IDENTITY.md file.
 * Strips YAML frontmatter if present — only the markdown body is returned.
 */
export async function loadIdentity(identityPath: string): Promise<string> {
  const raw = await readFile(identityPath, "utf-8");
  const { body } = parseFrontmatter(raw);
  return body;
}
