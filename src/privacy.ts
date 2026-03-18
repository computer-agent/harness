import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { getHomeDir } from "./config.js";
import type { Logger } from "./logger.js";

export interface PrivacyConfig {
  sessionRetentionDays: number;
  workspaceRetentionDays: number;
  usageRetentionDays: number;
  policyVersion: string;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  sessionRetentionDays: 90,
  workspaceRetentionDays: 365,
  usageRetentionDays: 365,
  policyVersion: "2026-03-01",
};

interface ConsentRecord {
  userId: string;
  policyVersion: string;
  grantedAt: string;
}

interface DeletionReport {
  userId: string;
  deleted: {
    sessions: number;
    memoryFiles: number;
    workspaceFiles: number;
    usageFile: boolean;
    consentFile: boolean;
  };
  notDeleted: string[];
}

interface CleanupReport {
  sessionsDeleted: number;
  workspaceFilesDeleted: number;
  usageFilesDeleted: number;
}

// ─── Consent ───

export async function checkConsent(userId: string, policyVersion: string): Promise<boolean> {
  const consentPath = join(getHomeDir(), "state", "consent", `${userId}.json`);
  try {
    const raw = await readFile(consentPath, "utf-8");
    const record: ConsentRecord = JSON.parse(raw);
    return record.policyVersion === policyVersion;
  } catch {
    return false;
  }
}

export async function recordConsent(userId: string, policyVersion: string): Promise<void> {
  const consentDir = join(getHomeDir(), "state", "consent");
  await mkdir(consentDir, { recursive: true });
  const record: ConsentRecord = {
    userId,
    policyVersion,
    grantedAt: new Date().toISOString(),
  };
  await writeFile(join(consentDir, `${userId}.json`), JSON.stringify(record, null, 2));
}

// ─── Data Export ───

export async function exportUserData(userId: string): Promise<Buffer> {
  const homeDir = getHomeDir();
  const agentsDir = join(homeDir, "agents");
  const chunks: Buffer[] = [];

  // Use archiver to create a ZIP in memory
  const archive = archiver("zip", { zlib: { level: 9 } });
  const bufferStream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  const pipelinePromise = pipeline(archive, bufferStream);

  // Add metadata
  archive.append(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        userId,
      },
      null,
      2,
    ),
    { name: `export-${userId}/metadata.json` },
  );

  // Scan agents
  try {
    const agents = await readdir(agentsDir);
    for (const agentId of agents) {
      // Sessions
      const sessionsDir = join(homeDir, "state", agentId, "sessions", userId);
      await addDirectoryToArchive(archive, sessionsDir, `export-${userId}/agents/${agentId}/sessions`);

      // Memory
      const memoryDir = join(agentsDir, agentId, "memory", userId);
      await addDirectoryToArchive(archive, memoryDir, `export-${userId}/agents/${agentId}/memory`);

      // Workspace
      const workspaceDir = join(agentsDir, agentId, "workspace", userId);
      await addDirectoryToArchive(archive, workspaceDir, `export-${userId}/agents/${agentId}/workspace`);
    }
  } catch {
    // No agents directory
  }

  // Usage data
  const usagePath = join(homeDir, "state", "usage", `${userId}.json`);
  try {
    const usageData = await readFile(usagePath, "utf-8");
    archive.append(usageData, { name: `export-${userId}/usage.json` });
  } catch {
    // No usage data
  }

  // Consent record
  const consentPath = join(homeDir, "state", "consent", `${userId}.json`);
  try {
    const consentData = await readFile(consentPath, "utf-8");
    archive.append(consentData, { name: `export-${userId}/consent.json` });
  } catch {
    // No consent record
  }

  await archive.finalize();
  await pipelinePromise;

  return Buffer.concat(chunks);
}

async function addDirectoryToArchive(archive: archiver.Archiver, dirPath: string, archivePath: string): Promise<void> {
  try {
    const files = await readdir(dirPath, { recursive: true });
    for (const file of files) {
      const fullPath = join(dirPath, file.toString());
      try {
        const s = await stat(fullPath);
        if (s.isFile()) {
          archive.file(fullPath, { name: `${archivePath}/${file}` });
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Directory doesn't exist
  }
}

// ─── Data Deletion ───

export async function deleteUserData(userId: string): Promise<DeletionReport> {
  const homeDir = getHomeDir();
  const agentsDir = join(homeDir, "agents");
  const report: DeletionReport = {
    userId,
    deleted: { sessions: 0, memoryFiles: 0, workspaceFiles: 0, usageFile: false, consentFile: false },
    notDeleted: [
      "access.yaml token entry (operator manages manually)",
      "Structured logs (operational, no message content)",
      "SDK-managed session data (managed by Claude Agent SDK)",
    ],
  };

  // Scan agents and delete user data
  try {
    const agents = await readdir(agentsDir);
    for (const agentId of agents) {
      // Sessions
      const sessionsDir = join(homeDir, "state", agentId, "sessions", userId);
      report.deleted.sessions += await deleteDirectory(sessionsDir);

      // Memory
      const memoryDir = join(agentsDir, agentId, "memory", userId);
      report.deleted.memoryFiles += await deleteDirectory(memoryDir);

      // Workspace
      const workspaceDir = join(agentsDir, agentId, "workspace", userId);
      report.deleted.workspaceFiles += await deleteDirectory(workspaceDir);
    }
  } catch {
    // No agents directory
  }

  // Usage data
  const usagePath = join(homeDir, "state", "usage", `${userId}.json`);
  try {
    await rm(usagePath);
    report.deleted.usageFile = true;
  } catch {
    // No usage file
  }

  // Consent record
  const consentPath = join(homeDir, "state", "consent", `${userId}.json`);
  try {
    await rm(consentPath);
    report.deleted.consentFile = true;
  } catch {
    // No consent file
  }

  return report;
}

async function deleteDirectory(dirPath: string): Promise<number> {
  try {
    const files = await readdir(dirPath, { recursive: true });
    const count = files.length;
    await rm(dirPath, { recursive: true, force: true });
    return count;
  } catch {
    return 0;
  }
}

// ─── Retention Cleanup ───

export async function runRetentionCleanup(config: PrivacyConfig, logger?: Logger): Promise<CleanupReport> {
  const homeDir = getHomeDir();
  const now = Date.now();
  const report: CleanupReport = { sessionsDeleted: 0, workspaceFilesDeleted: 0, usageFilesDeleted: 0 };

  const sessionCutoff = now - config.sessionRetentionDays * 24 * 60 * 60 * 1000;
  const workspaceCutoff = now - config.workspaceRetentionDays * 24 * 60 * 60 * 1000;
  const usageCutoff = now - config.usageRetentionDays * 24 * 60 * 60 * 1000;

  // Clean old session data
  const stateDir = join(homeDir, "state");
  try {
    const agentDirs = await readdir(stateDir);
    for (const agentDir of agentDirs) {
      if (agentDir === "usage" || agentDir === "consent") continue;
      const sessionsBase = join(stateDir, agentDir, "sessions");
      report.sessionsDeleted += await cleanOldFiles(sessionsBase, sessionCutoff);
    }
  } catch {
    /* no state dir */
  }

  // Clean old workspace files
  const agentsDir = join(homeDir, "agents");
  try {
    const agents = await readdir(agentsDir);
    for (const agentId of agents) {
      const workspaceBase = join(agentsDir, agentId, "workspace");
      report.workspaceFilesDeleted += await cleanOldFiles(workspaceBase, workspaceCutoff);
    }
  } catch {
    /* no agents dir */
  }

  // Clean old usage data
  const usageDir = join(stateDir, "usage");
  try {
    const files = await readdir(usageDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(usageDir, file);
      try {
        const s = await stat(filePath);
        if (s.mtimeMs < usageCutoff) {
          await rm(filePath);
          report.usageFilesDeleted++;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no usage dir */
  }

  logger?.info(
    "server",
    "retention.cleanup",
    `Retention cleanup: ${report.sessionsDeleted} sessions, ${report.workspaceFilesDeleted} workspace files, ${report.usageFilesDeleted} usage files deleted`,
  );

  return report;
}

async function cleanOldFiles(baseDir: string, cutoffMs: number): Promise<number> {
  let count = 0;
  try {
    const userDirs = await readdir(baseDir);
    for (const userDir of userDirs) {
      const userPath = join(baseDir, userDir);
      try {
        const s = await stat(userPath);
        if (s.isDirectory() && s.mtimeMs < cutoffMs) {
          const files = await readdir(userPath, { recursive: true });
          count += files.length;
          await rm(userPath, { recursive: true, force: true });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir doesn't exist */
  }
  return count;
}

// ─── Privacy Disclosure ───

export function privacyDisclosure(policyVersion: string): object {
  return {
    policyVersion,
    dataCollected: [
      {
        type: "Session metadata",
        description: "Session ID, name, timestamps",
        retention: "Configurable (default 90 days)",
      },
      {
        type: "User memory",
        description: "Agent-written notes about interactions",
        retention: "Configurable (default 365 days)",
      },
      { type: "User workspace", description: "Files created by agents", retention: "Configurable (default 365 days)" },
      { type: "Usage data", description: "Token counts and timestamps", retention: "Configurable (default 365 days)" },
      {
        type: "Access logs",
        description: "Timestamps, agent used, tool calls (no message content)",
        retention: "Operational",
      },
    ],
    dataUse:
      "Your data is used to provide the AI agent service, maintain session continuity, and track usage for billing purposes.",
    rights: {
      access: "GET /api/users/:userId/data — Export all your data as a ZIP archive",
      deletion: "Contact the operator to request deletion of all your data",
      privacy: "GET /api/privacy — This document",
    },
    contact: "Contact the system operator for data-related requests.",
  };
}
