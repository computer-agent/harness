import { beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "@/types";
import { conversationKey, useChatStore } from "./chat";

function resetStore() {
  useChatStore.setState({
    messages: [],
    activeKey: "",
    pendingMessages: [],
    lastMessageId: 0,
    lastUserMessage: null,
    isStreaming: false,
    rateLimitedUntil: null,
    agentStatus: "idle",
    subagentTasks: [],
    cache: {},
  });
}

describe("conversationKey", () => {
  it("returns agentId:sessionId when sessionId is provided", () => {
    expect(conversationKey("researcher", "abc123")).toBe("researcher:abc123");
  });

  it("returns agentId:new when sessionId is null", () => {
    expect(conversationKey("researcher", null)).toBe("researcher:new");
  });
});

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("addUserMessage", () => {
    it("adds a user message with correct structure", () => {
      useChatStore.getState().addUserMessage("hello");
      const { messages, lastUserMessage } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
      expect(messages[0].id).toMatch(/^user-\d+$/);
      expect(messages[0].timestamp).toBeTruthy();
      expect(lastUserMessage).toBe("hello");
    });

    it("appends to existing messages", () => {
      useChatStore.getState().addUserMessage("first");
      useChatStore.getState().addUserMessage("second");
      const { messages } = useChatStore.getState();

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("first");
      expect(messages[1].content).toBe("second");
    });
  });

  describe("startAssistantMessage", () => {
    it("creates a streaming assistant message", () => {
      useChatStore.getState().startAssistantMessage();
      const { messages, isStreaming } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toBe("");
      expect(messages[0].isStreaming).toBe(true);
      expect(messages[0].toolCalls).toEqual([]);
      expect(isStreaming).toBe(true);
    });
  });

  describe("appendToken", () => {
    it("appends text to the last assistant message", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().appendToken("Hello", 1);
      useChatStore.getState().appendToken(" world", 2);
      const { messages, lastMessageId } = useChatStore.getState();

      expect(messages[0].content).toBe("Hello world");
      expect(messages[0].isStreaming).toBe(true);
      expect(lastMessageId).toBe(2);
    });

    it("tracks the maximum message id", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().appendToken("a", 5);
      useChatStore.getState().appendToken("b", 3); // lower id
      expect(useChatStore.getState().lastMessageId).toBe(5);
    });

    it("does nothing when last message is not an assistant message", () => {
      useChatStore.getState().addUserMessage("hi");
      useChatStore.getState().appendToken("ignored", 1);
      const { messages } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("hi");
    });
  });

  describe("appendThinkingToken", () => {
    it("appends to thinkingContent on the last assistant message", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().appendThinkingToken("Let me think");
      useChatStore.getState().appendThinkingToken("...");
      const { messages } = useChatStore.getState();

      expect(messages[0].thinkingContent).toBe("Let me think...");
    });
  });

  describe("finalizeAssistantMessage", () => {
    it("marks the message complete and updates cache", () => {
      useChatStore.setState({ activeKey: "agent:session1" });
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().appendToken("partial", 1);
      useChatStore.getState().finalizeAssistantMessage("full response", 10);
      const { messages, isStreaming, lastMessageId, cache } = useChatStore.getState();

      expect(messages[0].content).toBe("full response");
      expect(messages[0].isStreaming).toBe(false);
      expect(isStreaming).toBe(false);
      expect(lastMessageId).toBe(10);
      expect(cache["agent:session1"]).toBeDefined();
      expect(cache["agent:session1"].messages[0].content).toBe("full response");
    });

    it("marks executing tool calls as complete", () => {
      useChatStore.getState().startAssistantMessage();
      const tool: ToolCall = { id: "t1", name: "read", inputJson: "{}", status: "executing" };
      useChatStore.getState().addToolCall(tool);
      useChatStore.getState().finalizeAssistantMessage("done", 5);
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls?.[0].status).toBe("complete");
    });

    it("does not change non-executing tool call statuses", () => {
      useChatStore.getState().startAssistantMessage();
      const tool: ToolCall = { id: "t1", name: "read", inputJson: "{}", status: "error" };
      useChatStore.getState().addToolCall(tool);
      useChatStore.getState().finalizeAssistantMessage("done", 5);
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls?.[0].status).toBe("error");
    });
  });

  describe("addToolCall", () => {
    it("adds a tool call to the last assistant message", () => {
      useChatStore.getState().startAssistantMessage();
      const tool: ToolCall = { id: "t1", name: "read_file", inputJson: '{"path":"/a"}', status: "executing" };
      useChatStore.getState().addToolCall(tool);
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls).toHaveLength(1);
      expect(messages[0].toolCalls?.[0]).toEqual(tool);
    });

    it("appends to existing tool calls", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().addToolCall({ id: "t1", name: "read", inputJson: "{}", status: "executing" });
      useChatStore.getState().addToolCall({ id: "t2", name: "write", inputJson: "{}", status: "executing" });
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls).toHaveLength(2);
      expect(messages[0].toolCalls?.[0].id).toBe("t1");
      expect(messages[0].toolCalls?.[1].id).toBe("t2");
    });
  });

  describe("updateToolInput", () => {
    it("appends partial JSON to the matching tool call", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().addToolCall({ id: "t1", name: "read", inputJson: '{"pa', status: "executing" });
      useChatStore.getState().updateToolInput("t1", 'th":"/a"}');
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls?.[0].inputJson).toBe('{"path":"/a"}');
    });
  });

  describe("switchConversation", () => {
    it("saves current messages to cache and loads target", () => {
      useChatStore.setState({ activeKey: "agent:s1" });
      useChatStore.getState().addUserMessage("in s1");

      useChatStore.getState().switchConversation("agent:s2");
      const afterSwitch = useChatStore.getState();

      expect(afterSwitch.activeKey).toBe("agent:s2");
      expect(afterSwitch.messages).toEqual([]);
      expect(afterSwitch.isStreaming).toBe(false);
      expect(afterSwitch.agentStatus).toBe("idle");
      // s1 is cached
      expect(afterSwitch.cache["agent:s1"]).toBeDefined();
      expect(afterSwitch.cache["agent:s1"].messages).toHaveLength(1);
    });

    it("loads cached messages for previously visited conversation", () => {
      useChatStore.setState({ activeKey: "agent:s1" });
      useChatStore.getState().addUserMessage("message in s1");
      useChatStore.getState().switchConversation("agent:s2");
      useChatStore.getState().addUserMessage("message in s2");
      useChatStore.getState().switchConversation("agent:s1");
      const { messages } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("message in s1");
    });

    it("does not cache empty conversations", () => {
      useChatStore.setState({ activeKey: "agent:empty" });
      // No messages added
      useChatStore.getState().switchConversation("agent:s2");
      const { cache } = useChatStore.getState();

      expect(cache["agent:empty"]).toBeUndefined();
    });
  });

  describe("updateActiveKey", () => {
    it("migrates cache entry from old key to new key", () => {
      useChatStore.setState({ activeKey: "agent:new" });
      useChatStore.getState().addUserMessage("hello");
      useChatStore.getState().updateActiveKey("agent:real-session-id");
      const { activeKey, cache } = useChatStore.getState();

      expect(activeKey).toBe("agent:real-session-id");
      expect(cache["agent:new"]).toBeUndefined();
      expect(cache["agent:real-session-id"]).toBeDefined();
      expect(cache["agent:real-session-id"].messages).toHaveLength(1);
    });

    it("does nothing if the key has not changed", () => {
      useChatStore.setState({ activeKey: "agent:s1" });
      useChatStore.getState().addUserMessage("hello");
      useChatStore.getState().updateActiveKey("agent:s1");
      // Should not throw or mutate
      expect(useChatStore.getState().activeKey).toBe("agent:s1");
    });
  });

  describe("retryLastMessage", () => {
    it("removes the last error message and returns the last user message", () => {
      useChatStore.getState().addUserMessage("try this");
      useChatStore.getState().addError("something went wrong");
      const retried = useChatStore.getState().retryLastMessage();
      const { messages } = useChatStore.getState();

      expect(retried).toBe("try this");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("returns null when there is no last user message", () => {
      const retried = useChatStore.getState().retryLastMessage();
      expect(retried).toBeNull();
    });

    it("only removes the last error, not earlier ones", () => {
      useChatStore.getState().addUserMessage("first try");
      useChatStore.getState().addError("error 1");
      useChatStore.getState().addUserMessage("second try");
      useChatStore.getState().addError("error 2");

      useChatStore.getState().retryLastMessage();
      const { messages } = useChatStore.getState();

      // error 1 remains, error 2 removed
      const errors = messages.filter((m) => m.isError);
      expect(errors).toHaveLength(1);
      expect(errors[0].content).toBe("error 1");
    });
  });

  describe("clearMessages", () => {
    it("resets message state", () => {
      useChatStore.getState().addUserMessage("hello");
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().appendToken("world", 5);
      useChatStore.getState().clearMessages();
      const { messages, lastMessageId, lastUserMessage, isStreaming, agentStatus } = useChatStore.getState();

      expect(messages).toEqual([]);
      expect(lastMessageId).toBe(0);
      expect(lastUserMessage).toBeNull();
      expect(isStreaming).toBe(false);
      expect(agentStatus).toBe("idle");
    });
  });

  describe("addError", () => {
    it("adds an error message and stops streaming", () => {
      useChatStore.setState({ isStreaming: true, agentStatus: "thinking" });
      useChatStore.getState().addError("Network error", "NETWORK");
      const { messages, isStreaming, agentStatus } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].isError).toBe(true);
      expect(messages[0].content).toBe("Network error");
      expect(messages[0].errorCode).toBe("NETWORK");
      expect(messages[0].role).toBe("assistant");
      expect(isStreaming).toBe(false);
      expect(agentStatus).toBe("idle");
    });
  });

  describe("setToolCallApproval", () => {
    it("sets approval status on an existing tool call", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().addToolCall({ id: "t1", name: "shell", inputJson: "{}", status: "executing" });
      useChatStore.getState().setToolCallApproval("t1", "Allow shell access?");
      const { messages } = useChatStore.getState();

      const tc = messages[0].toolCalls?.[0];
      expect(tc?.status).toBe("needs_approval");
      expect(tc?.question).toBe("Allow shell access?");
    });

    it("creates a placeholder tool call if the id is not found", () => {
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().setToolCallApproval("t-unknown", "New tool?");
      const { messages } = useChatStore.getState();

      const tc = messages[0].toolCalls?.[0];
      expect(tc?.id).toBe("t-unknown");
      expect(tc?.status).toBe("needs_approval");
      expect(tc?.name).toBe("");
    });
  });

  describe("setToolResult", () => {
    it("finds a tool call across messages and sets its output", () => {
      // First assistant message with a tool call
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().addToolCall({ id: "t1", name: "read", inputJson: "{}", status: "executing" });
      // Second assistant message (simulating continued conversation)
      useChatStore.getState().startAssistantMessage();
      useChatStore.getState().addToolCall({ id: "t2", name: "write", inputJson: "{}", status: "executing" });

      // Set result on the tool in the first message
      useChatStore.getState().setToolResult("t1", "file contents here");
      const { messages } = useChatStore.getState();

      expect(messages[0].toolCalls?.[0].output).toBe("file contents here");
      expect(messages[0].toolCalls?.[0].status).toBe("complete");
      // t2 is untouched
      expect(messages[1].toolCalls?.[0].output).toBeUndefined();
    });
  });

  describe("loadHistory", () => {
    it("replaces messages and updates cache", () => {
      useChatStore.setState({ activeKey: "agent:s1", lastMessageId: 5 });
      const history = [
        { id: "h1", role: "user" as const, content: "old", timestamp: "2026-01-01T00:00:00Z" },
        { id: "h2", role: "assistant" as const, content: "reply", timestamp: "2026-01-01T00:00:01Z" },
      ];
      useChatStore.getState().loadHistory(history);
      const { messages, cache, isStreaming, agentStatus } = useChatStore.getState();

      expect(messages).toEqual(history);
      expect(cache["agent:s1"].messages).toEqual(history);
      expect(isStreaming).toBe(false);
      expect(agentStatus).toBe("idle");
    });
  });

  describe("pendingMessages", () => {
    it("queues and flushes pending messages", () => {
      useChatStore.getState().queuePendingMessage("msg1");
      useChatStore.getState().queuePendingMessage("msg2");
      expect(useChatStore.getState().pendingMessages).toEqual(["msg1", "msg2"]);

      const flushed = useChatStore.getState().flushPendingMessages();
      expect(flushed).toEqual(["msg1", "msg2"]);
      expect(useChatStore.getState().pendingMessages).toEqual([]);
    });
  });

  describe("subagent tasks", () => {
    it("adds, updates progress, and completes a subagent task", () => {
      useChatStore.getState().addSubagentTask("task-1", "Research topic");
      expect(useChatStore.getState().subagentTasks).toHaveLength(1);
      expect(useChatStore.getState().subagentTasks[0]).toEqual({
        taskId: "task-1",
        description: "Research topic",
        status: "running",
        toolUses: 0,
        durationMs: 0,
        totalTokens: 0,
      });

      useChatStore.getState().updateSubagentProgress("task-1", 5, 1200, 500);
      expect(useChatStore.getState().subagentTasks[0].toolUses).toBe(5);
      expect(useChatStore.getState().subagentTasks[0].durationMs).toBe(1200);

      useChatStore.getState().completeSubagentTask("task-1", "completed", "Done researching", 1000);
      const task = useChatStore.getState().subagentTasks[0];
      expect(task.status).toBe("completed");
      expect(task.summary).toBe("Done researching");
      expect(task.totalTokens).toBe(1000);
    });

    it("clears all subagent tasks", () => {
      useChatStore.getState().addSubagentTask("task-1", "A");
      useChatStore.getState().addSubagentTask("task-2", "B");
      useChatStore.getState().clearSubagentTasks();
      expect(useChatStore.getState().subagentTasks).toEqual([]);
    });
  });

  describe("setStatus and setStreaming", () => {
    it("updates agent status", () => {
      useChatStore.getState().setStatus("thinking");
      expect(useChatStore.getState().agentStatus).toBe("thinking");
    });

    it("updates streaming state", () => {
      useChatStore.getState().setStreaming(true);
      expect(useChatStore.getState().isStreaming).toBe(true);
    });
  });

  describe("removeErrorMessage", () => {
    it("removes a specific error message by id", () => {
      useChatStore.getState().addError("err1");
      const errId = useChatStore.getState().messages[0].id;
      useChatStore.getState().addUserMessage("after error");
      useChatStore.getState().removeErrorMessage(errId);
      const { messages } = useChatStore.getState();

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("after error");
    });
  });

  describe("setRateLimitedUntil", () => {
    it("stores and clears the rate limit timestamp", () => {
      useChatStore.getState().setRateLimitedUntil(Date.now() + 60000);
      expect(useChatStore.getState().rateLimitedUntil).toBeGreaterThan(0);

      useChatStore.getState().setRateLimitedUntil(null);
      expect(useChatStore.getState().rateLimitedUntil).toBeNull();
    });
  });
});
