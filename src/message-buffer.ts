import type { WsServerMessage } from "./types/ws.js";

export class MessageBuffer {
  private buffer: Array<WsServerMessage & { id?: number }> = [];
  private maxSize: number;
  private counter = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /** Get the next monotonic message ID */
  nextId(): number {
    return ++this.counter;
  }

  /** Push a message into the buffer */
  push(msg: WsServerMessage & { id?: number }): void {
    this.buffer.push(msg);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /** Get all messages with id > afterId */
  since(afterId: number): WsServerMessage[] {
    return this.buffer.filter((m) => m.id !== undefined && m.id > afterId);
  }

  /** Get the most recent message ID */
  lastId(): number {
    return this.counter;
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer = [];
  }
}
