/**
 * Structured JSON logging for serve mode.
 *
 * Every log line is a single JSON object written to stdout.
 * NEVER logs: message content, API keys, tokens, or full tool inputs/outputs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory = "auth" | "session" | "agent" | "tool" | "mcp" | "cost" | "health" | "server" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  requestId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  category: LogCategory;
  event: string;
  message: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerFields {
  requestId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export class Logger {
  private readonly minLevel: number;
  private readonly fields: LoggerFields;
  private readonly writeFn: (line: string) => void;

  constructor(level: LogLevel = "info", fields: LoggerFields = {}, writeFn?: (line: string) => void) {
    this.minLevel = LEVEL_ORDER[level];
    this.fields = fields;
    this.writeFn = writeFn ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  /** Create a child logger with additional pre-filled fields. */
  child(fields: LoggerFields): Logger {
    return new Logger(this.levelName(), { ...this.fields, ...fields }, this.writeFn);
  }

  debug(
    category: LogCategory,
    event: string,
    message: string,
    extra?: { details?: Record<string, unknown>; durationMs?: number },
  ): void {
    this.log("debug", category, event, message, extra);
  }

  info(
    category: LogCategory,
    event: string,
    message: string,
    extra?: { details?: Record<string, unknown>; durationMs?: number },
  ): void {
    this.log("info", category, event, message, extra);
  }

  warn(
    category: LogCategory,
    event: string,
    message: string,
    extra?: { details?: Record<string, unknown>; durationMs?: number },
  ): void {
    this.log("warn", category, event, message, extra);
  }

  error(
    category: LogCategory,
    event: string,
    message: string,
    extra?: { details?: Record<string, unknown>; durationMs?: number },
  ): void {
    this.log("error", category, event, message, extra);
  }

  private levelName(): LogLevel {
    for (const [name, order] of Object.entries(LEVEL_ORDER)) {
      if (order === this.minLevel) return name as LogLevel;
    }
    return "info";
  }

  private log(
    level: LogLevel,
    category: LogCategory,
    event: string,
    message: string,
    extra?: { details?: Record<string, unknown>; durationMs?: number },
  ): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      ...this.fields,
      category,
      event,
      message,
    };

    if (extra?.details !== undefined) entry.details = extra.details;
    if (extra?.durationMs !== undefined) entry.durationMs = extra.durationMs;

    this.writeFn(JSON.stringify(entry));
  }
}
