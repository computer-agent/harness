import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionDirs } from "./sessions.js";

export interface PersistedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: { name: string; status: string }[];
}

function messagesPath(dirs: SessionDirs, sessionId: string): string {
  return join(dirs.sessionsDir, sessionId, "messages.jsonl");
}

export async function appendMessage(
  dirs: SessionDirs,
  sessionId: string,
  message: PersistedMessage,
): Promise<void> {
  const filePath = messagesPath(dirs, sessionId);
  await mkdir(join(dirs.sessionsDir, sessionId), { recursive: true });
  await appendFile(filePath, JSON.stringify(message) + "\n", "utf-8");
}

export async function loadMessages(
  dirs: SessionDirs,
  sessionId: string,
): Promise<PersistedMessage[]> {
  const filePath = messagesPath(dirs, sessionId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: PersistedMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt lines
    }
  }
  return messages;
}
