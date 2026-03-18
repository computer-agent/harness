import { randomUUID } from "node:crypto";
import type { TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, buildSystemPrompt, sendMessage } from "../agent.js";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";

function extractTextFromMessage(message: { parts: Array<{ kind: string; text?: string }> }): string {
  return message.parts
    .filter((p) => p.kind === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
}

export class HarnessExecutor implements AgentExecutor {
  private activeQueries = new Map<string, Query>();

  constructor(
    private readonly agentContext: AgentContext,
    private readonly config: HarnessConfig,
  ) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const prompt = extractTextFromMessage(ctx.userMessage);

    // Signal that work has started
    const workingEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      final: false,
      status: { state: "working" },
    };
    eventBus.publish(workingEvent);

    try {
      const { systemPrompt } = await buildSystemPrompt(this.agentContext, this.config);
      const options = buildOptions(this.agentContext, { systemPrompt }, this.config);
      const q = sendMessage(prompt, options);
      this.activeQueries.set(ctx.taskId, q);

      let result = "";
      let isError = false;
      let errorMessages: string[] = [];
      for await (const msg of q) {
        if (msg.type === "result") {
          const r = msg as Record<string, unknown>;
          if (r.is_error || r.subtype !== "success") {
            isError = true;
            errorMessages = (r.errors as string[]) ?? [`Agent ended with status: ${r.subtype}`];
          } else {
            result = (r.result as string) ?? "";
          }
        }
      }

      if (isError) {
        const failedEvent: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          final: true,
          status: {
            state: "failed",
            message: {
              kind: "message",
              messageId: randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: errorMessages.join("\n") }],
            },
          },
        };
        eventBus.publish(failedEvent);
      } else {
        const completedEvent: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          final: true,
          status: {
            state: "completed",
            message: {
              kind: "message",
              messageId: randomUUID(),
              role: "agent",
              parts: [{ kind: "text", text: result }],
            },
          },
        };
        eventBus.publish(completedEvent);
      }
    } catch (err) {
      const failedEvent: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        final: true,
        status: {
          state: "failed",
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: `Agent execution failed: ${err}` }],
          },
        },
      };
      eventBus.publish(failedEvent);
    }

    this.activeQueries.delete(ctx.taskId);
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const q = this.activeQueries.get(taskId);
    if (q) {
      q.interrupt();
      this.activeQueries.delete(taskId);
    }
    eventBus.finished();
  }
}
