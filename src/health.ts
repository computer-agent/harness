/**
 * Health monitoring for serve mode.
 *
 * Provides two levels of health checks:
 * - Shallow: fast, no auth, no external calls — for load balancers
 * - Deep: admin-only, cached 30s — checks Anthropic API, filesystem
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "./config.js";
import type { Logger } from "./logger.js";

export interface ShallowHealth {
  status: "healthy" | "shutting_down";
  version: string;
  uptime: number;
  activeSessions: number;
  activeConnections: number;
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
}

export interface WorkerPoolStats {
  active: number;
  max: number;
  utilization: number; // 0.0–1.0
}

export interface DeepHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    anthropicApi: { status: "healthy" | "unhealthy"; latencyMs?: number; error?: string };
    filesystem: { status: "healthy" | "unhealthy"; agentsDir: boolean; stateDir: boolean };
  };
  stats: {
    activeSessions: number;
    activeConnections: number;
    errorRate1h: number;
    memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number };
    workerPool: WorkerPoolStats; // W6-T09
  };
}

export class HealthMonitor {
  private errors: number[] = []; // timestamps of errors in last hour
  private successes: number[] = []; // timestamps of successes in last hour
  private deepCache: { result: DeepHealth; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 30_000; // 30 seconds
  private readonly ERROR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private isShuttingDown = false;

  constructor(
    private readonly version: string,
    private readonly getActiveSessions: () => number,
    private readonly getActiveConnections: () => number,
    private readonly logger?: Logger,
    private readonly getWorkerPoolStats?: () => WorkerPoolStats,
  ) {}

  setShuttingDown(): void {
    this.isShuttingDown = true;
  }

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  recordError(): void {
    this.errors.push(Date.now());
  }

  recordSuccess(): void {
    this.successes.push(Date.now());
  }

  shallowCheck(): ShallowHealth {
    const mem = process.memoryUsage();
    return {
      status: this.isShuttingDown ? "shutting_down" : "healthy",
      version: this.version,
      uptime: Math.floor(process.uptime()),
      activeSessions: this.getActiveSessions(),
      activeConnections: this.getActiveConnections(),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
    };
  }

  async deepCheck(): Promise<DeepHealth> {
    // Return cached result if fresh enough
    if (this.deepCache && Date.now() - this.deepCache.timestamp < this.CACHE_TTL_MS) {
      return this.deepCache.result;
    }

    const mem = process.memoryUsage();
    const errorRate = this.getErrorRate();

    // Check Anthropic API
    const apiCheck = await this.checkAnthropicApi();

    // Check filesystem
    const fsCheck = await this.checkFilesystem();

    const overallStatus =
      apiCheck.status === "unhealthy" || fsCheck.status === "unhealthy"
        ? "degraded"
        : errorRate > 0.05
          ? "degraded"
          : "healthy";

    // W6-T09: Worker pool utilization
    const workerPool = this.getWorkerPoolStats ? this.getWorkerPoolStats() : { active: 0, max: 0, utilization: 0 };

    const result: DeepHealth = {
      status: overallStatus,
      checks: {
        anthropicApi: apiCheck,
        filesystem: fsCheck,
      },
      stats: {
        activeSessions: this.getActiveSessions(),
        activeConnections: this.getActiveConnections(),
        errorRate1h: Math.round(errorRate * 1000) / 1000,
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        workerPool,
      },
    };

    this.deepCache = { result, timestamp: Date.now() };
    return result;
  }

  private getErrorRate(): number {
    const now = Date.now();
    const cutoff = now - this.ERROR_WINDOW_MS;

    // Clean old entries
    this.errors = this.errors.filter((t) => t > cutoff);
    this.successes = this.successes.filter((t) => t > cutoff);

    const total = this.errors.length + this.successes.length;
    if (total === 0) return 0;
    return this.errors.length / total;
  }

  private async checkAnthropicApi(): Promise<{
    status: "healthy" | "unhealthy";
    latencyMs?: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return { status: "unhealthy", latencyMs: Date.now() - start, error: "ANTHROPIC_API_KEY not set" };
      }
      // Lightweight API check: list models with limit=1
      const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000), // 5s timeout for the API check
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          status: "unhealthy",
          latencyMs: Date.now() - start,
          error: `API returned ${response.status}: ${text.slice(0, 200)}`,
        };
      }
      return { status: "healthy", latencyMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn("health", "health.api_check_failed", `Anthropic API check failed: ${message}`);
      return { status: "unhealthy", latencyMs: Date.now() - start, error: message };
    }
  }

  private async checkFilesystem(): Promise<{
    status: "healthy" | "unhealthy";
    agentsDir: boolean;
    stateDir: boolean;
  }> {
    const homeDir = getHomeDir();
    const agentsDir = join(homeDir, "agents");
    const stateDir = join(homeDir, "state");

    let agentsDirOk = false;
    let stateDirOk = false;

    try {
      await access(agentsDir);
      agentsDirOk = true;
    } catch {
      /* not accessible */
    }

    try {
      await access(stateDir);
      stateDirOk = true;
    } catch {
      /* not accessible */
    }

    return {
      status: agentsDirOk && stateDirOk ? "healthy" : "unhealthy",
      agentsDir: agentsDirOk,
      stateDir: stateDirOk,
    };
  }
}
