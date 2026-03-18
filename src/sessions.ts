import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { safePath, validateSessionId } from "./path-safety.js";

export interface SessionDirs {
  sessionsDir: string;
  lastSessionFile: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

// --- CRUD ---

export async function saveSession(dirs: SessionDirs, meta: SessionMeta): Promise<void> {
  validateSessionId(meta.id);
  await mkdir(dirs.sessionsDir, { recursive: true });
  await writeFile(safePath(dirs.sessionsDir, `${meta.id}.json`), JSON.stringify(meta, null, 2), "utf-8");
  await writeFile(dirs.lastSessionFile, meta.id, "utf-8");
}

export async function loadSession(dirs: SessionDirs, id: string): Promise<SessionMeta | null> {
  try {
    validateSessionId(id);
    const raw = await readFile(safePath(dirs.sessionsDir, `${id}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listSessions(dirs: SessionDirs): Promise<SessionMeta[]> {
  try {
    const files = await readdir(dirs.sessionsDir);
    const sessions: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(safePath(dirs.sessionsDir, f), "utf-8");
        sessions.push(JSON.parse(raw));
      } catch {
        // skip corrupt files
      }
    }
    sessions.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
    return sessions;
  } catch {
    return [];
  }
}

export async function deleteSession(dirs: SessionDirs, id: string): Promise<boolean> {
  try {
    validateSessionId(id);
    await unlink(safePath(dirs.sessionsDir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function touchSession(dirs: SessionDirs, id: string): Promise<void> {
  const meta = await loadSession(dirs, id);
  if (!meta) return;
  meta.lastUsedAt = new Date().toISOString();
  await writeFile(safePath(dirs.sessionsDir, `${meta.id}.json`), JSON.stringify(meta, null, 2), "utf-8");
  await writeFile(dirs.lastSessionFile, id, "utf-8");
}

export async function renameSession(dirs: SessionDirs, id: string, name: string): Promise<void> {
  const meta = await loadSession(dirs, id);
  if (!meta) return;
  meta.name = name;
  await writeFile(safePath(dirs.sessionsDir, `${meta.id}.json`), JSON.stringify(meta, null, 2), "utf-8");
}

export async function getLastSessionId(dirs: SessionDirs): Promise<string | null> {
  try {
    const id = await readFile(dirs.lastSessionFile, "utf-8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

// --- Naming ---

function nameFromMessage(msg: string): string {
  // Strip XML tags (SDK wraps commands in tags)
  let stripped = msg;
  // Loop to handle nested/incomplete tags (e.g. "<scr<script>ipt>")
  let prev = "";
  while (prev !== stripped) {
    prev = stripped;
    stripped = stripped.replace(/<[^>]+>/g, "");
  }
  stripped = stripped.trim();
  // Take first line only
  const firstLine = (stripped.split("\n")[0] ?? "").trim();
  if (!firstLine) return "Untitled session";
  if (firstLine.length <= 60) return firstLine;
  // Truncate at word boundary
  const truncated = firstLine.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 20 ? `${truncated.slice(0, lastSpace)}…` : `${truncated}…`;
}

export function createSessionMeta(id: string, firstMessage: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    name: nameFromMessage(firstMessage),
    createdAt: now,
    lastUsedAt: now,
  };
}

// --- Fuzzy search ---

export function findSessionByName(query: string, sessions: SessionMeta[]): SessionMeta | null {
  const q = query.toLowerCase();

  let best: SessionMeta | null = null;
  let bestScore = 0;

  for (const s of sessions) {
    const name = s.name.toLowerCase();
    let score = 0;

    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 2;
    else {
      const words = name.split(/\s+/);
      if (words.some((w) => w.startsWith(q))) score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return bestScore > 0 ? best : null;
}

// --- Relative time ---

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
