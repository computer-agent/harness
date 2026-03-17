import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import type { Logger } from "./logger.js";

export interface WatcherCallbacks {
  onRosterChange: () => Promise<void>;
  onConfigChange: () => Promise<void>;
  onAccessChange: () => Promise<void>;
}

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private stopped = false;

  constructor(
    private readonly agentsDir: string,
    private readonly configPath: string,
    private readonly accessPath: string,
    private readonly callbacks: WatcherCallbacks,
    private readonly logger?: Logger,
    debounceMs = 500,
  ) {
    this.debounceMs = debounceMs;
  }

  async start(): Promise<void> {
    // Watch agents directory recursively for IDENTITY.md changes
    try {
      const agentsWatcher = watch(this.agentsDir, { recursive: true }, (eventType, filename) => {
        if (this.stopped) return;
        if (!filename) return;
        // Only react to IDENTITY.md changes or directory-level changes
        if (filename.endsWith("IDENTITY.md") || filename.split("/").length <= 1) {
          this.debounce("roster", () => this.callbacks.onRosterChange());
        }
      });
      this.watchers.push(agentsWatcher);
      this.logger?.info("server", "watcher.started", `Watching agents directory: ${this.agentsDir}`);
    } catch (err) {
      this.logger?.warn("server", "watcher.failed", `Failed to watch agents directory: ${err}`);
    }

    // Watch config file
    await this.watchFile(this.configPath, "config", () => this.callbacks.onConfigChange());

    // Watch access file
    await this.watchFile(this.accessPath, "access", () => this.callbacks.onAccessChange());
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.logger?.info("server", "watcher.stopped", "File watchers closed");
  }

  private async watchFile(filePath: string, key: string, callback: () => Promise<void>): Promise<void> {
    try {
      await stat(filePath); // verify file exists
      const watcher = watch(filePath, (eventType) => {
        if (this.stopped) return;
        this.debounce(key, callback);
      });
      this.watchers.push(watcher);
      this.logger?.info("server", "watcher.started", `Watching file: ${filePath}`);
    } catch {
      this.logger?.warn("server", "watcher.skipped", `File not found, skipping watch: ${filePath}`);
    }
  }

  private debounce(key: string, callback: () => Promise<void>): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(key, setTimeout(async () => {
      this.debounceTimers.delete(key);
      try {
        await callback();
      } catch (err) {
        this.logger?.error("server", "watcher.callback_error", `Watcher callback failed for ${key}: ${err}`);
      }
    }, this.debounceMs));
  }
}
