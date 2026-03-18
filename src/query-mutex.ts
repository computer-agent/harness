/**
 * Per-key async mutex — prevents concurrent SDK queries on the same conversation.
 *
 * Without this, a user sending two messages rapidly could start two SDK queries
 * on the same session, corrupting conversation state.
 *
 * Uses a proper queue pattern: waiters are enqueued and dequeued one at a time.
 */

export class QueryMutex {
  /** Map of key → queue of waiting resolvers. If a key is in the map, it's locked. */
  private readonly queues = new Map<string, Array<() => void>>();

  /**
   * Acquire a lock for the given key. If the key is already locked,
   * waits until all previous holders release.
   *
   * @returns A release function — call it when the query is done.
   */
  async acquire(key: string): Promise<() => void> {
    if (this.queues.has(key)) {
      // Key is locked — enqueue and wait
      return new Promise<() => void>((resolve) => {
        this.queues.get(key)?.push(() => {
          resolve(this.makeRelease(key));
        });
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

      if (queue.length > 0) {
        // Wake the next waiter — they become the lock holder
        const next = queue.shift()!;
        next();
      } else {
        // No waiters — delete the key (unlocked)
        this.queues.delete(key);
      }
    };
  }
}
