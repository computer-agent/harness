import { randomUUID } from "node:crypto";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { buildOptions, buildSystemPrompt, sendMessage } from "../agent.js";

function extractTextFromMessage(message: { parts: Array<{ kind: string; text?: string }> }): string {
  return message.parts
    .filter((p) => p.kind === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
}

export class HarnessExecutor implements AgentExecutor {
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
      const systemPrompt = await buildSystemPrompt(this.agentContext, this.config);
      const options = buildOptions(this.agentContext, { systemPrompt }, this.config);
      const q = sendMessage(prompt, options);

      let result = "";
      for await (const msg of q) {
        if (msg.type === "result") {
          const r = msg as Record<string, unknown>;
          result = (r.result as string) ?? "";
        }
      }

      // Signal completion with agent response
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

    eventBus.finished();
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // Basic cancellation — publish canceled status and finish
    eventBus.finished();
  }
}
