/**
 * Per-key async mutex — prevents concurrent SDK queries on the same conversation.
 *
 * Without this, a user sending two messages rapidly could start two SDK queries
 * on the same session, corrupting conversation state.
 *
 * Uses a proper queue pattern: waiters are enqueued and dequeued one at a time.
 */

interface QueueEntry {
  timedOut: boolean;
  resolve: () => void;
}

export class QueryMutex {
  /** Map of key → queue of waiting resolvers. If a key is in the map, it's locked. */
  private readonly queues = new Map<string, Array<QueueEntry>>();

  /**
   * Acquire a lock for the given key. If the key is already locked,
   * waits until all previous holders release.
   *
   * @param key - The mutex key (e.g. "agentId:userId")
   * @param timeoutMs - Optional timeout in milliseconds. If provided and the lock isn't
   *   acquired within this time, the waiter is removed from the queue and the returned
   *   promise rejects with a MutexTimeoutError.
   * @returns A release function — call it when the query is done.
   */
  async acquire(key: string, timeoutMs?: number): Promise<() => void> {
    if (this.queues.has(key)) {
      // Key is locked — enqueue and wait
      return new Promise<() => void>((resolve, reject) => {
        const entry: QueueEntry = { timedOut: false, resolve: () => {} };
        let timer: ReturnType<typeof setTimeout> | null = null;

        entry.resolve = () => {
          if (timer) clearTimeout(timer);
          if (!entry.timedOut) {
            resolve(this.makeRelease(key));
          }
        };

        this.queues.get(key)?.push(entry);

        if (timeoutMs !== undefined && timeoutMs > 0) {
          timer = setTimeout(() => {
            entry.timedOut = true;
            // Remove this waiter from the queue if still present
            const queue = this.queues.get(key);
            if (queue) {
              const idx = queue.indexOf(entry);
              if (idx !== -1) queue.splice(idx, 1);
            }
            reject(new MutexTimeoutError(key, timeoutMs));
          }, timeoutMs);
        }
      });
    }

    // Key is free — create queue (marks as locked) and return immediately
    this.queues.set(key, []);
    return this.makeRelease(key);
  }

  /** Check if a key is currently locked (for diagnostics). */
  isLocked(key: string): boolean {
    return this.queues.has(key);
  }

  private makeRelease(key: string): () => void {
    return () => {
      const queue = this.queues.get(key);
      if (!queue) return; // Already released (double-release is a no-op)

      // Skip timed-out entries and wake the first live waiter
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        if (!next.timedOut) {
          next.resolve();
          return;
        }
        // Entry timed out — skip it, try the next one
      }

      // No live waiters — unlock
      this.queues.delete(key);
    };
  }
}

export class MutexTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly timeoutMs: number,
  ) {
    super(`Mutex acquire timed out after ${timeoutMs}ms for key "${key}"`);
    this.name = "MutexTimeoutError";
  }
}
