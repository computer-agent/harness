import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { Box, Text, useApp, useInput } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { buildOptions, buildSystemPrompt, sendMessage } from "../agent.js";
import type { AgentContext } from "../agent-context.js";
import type { HarnessConfig } from "../config.js";
import { formatErrorShort } from "../errors.js";
import { extractSdkEvent } from "../sdk-stream.js";
import {
  createSessionMeta,
  findSessionByName,
  getLastSessionId,
  listSessions,
  loadSession,
  relativeTime,
  renameSession,
  type SessionDirs,
  type SessionMeta,
  saveSession,
  touchSession,
} from "../sessions.js";
import type { ParsedQuestion } from "../types/ask-user.js";
import { parseQuestions } from "../types/ask-user.js";
import { ChatHistory } from "./ChatHistory.js";
import { InputArea } from "./InputArea.js";
import type { MessageData } from "./Message.js";
import { QuestionSelector } from "./QuestionSelector.js";
import { StreamingResponse } from "./StreamingResponse.js";

const marked = new Marked(markedTerminal());

function renderMarkdown(text: string): string {
  const rendered = marked.parse(text);
  if (typeof rendered !== "string") return text;
  return rendered.replace(/\n+$/, "");
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${Math.round(n / 1000)}K`;
}

function totalInputTokens(usage: any): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
}

const MAX_CONTEXT = 1_000_000;

export interface ToolAction {
  name: string;
  detail?: string;
}

export interface SubagentProgress {
  taskId: string;
  description: string;
  toolUses: number;
  durationMs: number;
  totalTokens: number;
  status?: "running" | "completed" | "failed" | "stopped";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function extractToolDetail(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => {
    const v = input[key];
    return typeof v === "string" ? v : "";
  };
  switch (name) {
    case "shell_exec":
      return truncate(str("command"), 80);
    case "write_file":
    case "read_file":
      return str("path");
    case "list_files":
      return str("path") || "";
    case "memory_read":
    case "memory_write":
      return str("filename");
    case "web_search":
      return truncate(str("query"), 80);
    case "web_fetch":
      return truncate(str("url"), 80);
    default: {
      const first = Object.entries(input).find(([, v]) => typeof v === "string" && (v as string).length < 100);
      return first ? truncate(first[1] as string, 80) : "";
    }
  }
}

function agentBanner(name: string, model: string, effort: string): string {
  const displayName = name.toUpperCase();
  const padded = displayName.padStart(Math.floor((31 + displayName.length) / 2)).padEnd(31);
  const modelShort = model.replace("claude-", "");
  const infoLine = `${modelShort} · effort: ${effort}`.padEnd(31);
  return `  ╔═══════════════════════════════════════╗
  ║  ${padded}      ║
  ║  ${infoLine}      ║
  ║                                       ║
  ║  Type /help for available commands     ║
  ╚═══════════════════════════════════════╝`;
}

interface AppState {
  messages: MessageData[];
  streamBuffer: string;
  thinkingBuffer: string;
  isStreaming: boolean;
  lastResponse: string | null;
  sessionId: string | null;
  sessionName: string | null;
  lastListing: SessionMeta[] | null;
  error: string | null;
  inputKey: number;
  contextTokens: number;
  toolActions: ToolAction[];
  subagentProgress: Map<string, SubagentProgress>;
  agentName: string;
  effortOverride: "low" | "medium" | "high" | "max" | null;
  modelOverride: string | null;
  pendingQuestion: {
    questions: ParsedQuestion[];
    resolve: (answers: Record<string, string> | null) => void;
  } | null;
}

type Action =
  | { type: "ADD_USER_MESSAGE"; content: string }
  | { type: "ADD_SYSTEM_MESSAGE"; content: string }
  | { type: "STREAM_START" }
  | { type: "STREAM_TOKEN"; token: string }
  | { type: "THINKING_TOKEN"; token: string }
  | { type: "MESSAGE_COMPLETE"; rendered: string }
  | { type: "SET_SESSION"; sessionId: string | null }
  | { type: "SET_SESSION_NAME"; name: string | null }
  | { type: "SET_LISTING"; listing: SessionMeta[] | null }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "RESET_INPUT" }
  | { type: "UPDATE_CONTEXT"; tokens: number }
  | { type: "TOOL_USE"; name: string }
  | { type: "TOOL_USE_DETAIL"; detail: string }
  | { type: "SUBAGENT_STARTED"; taskId: string; description: string }
  | { type: "SUBAGENT_PROGRESS"; taskId: string; toolUses: number; durationMs: number; totalTokens: number }
  | {
      type: "SUBAGENT_DONE";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
      totalTokens: number;
    }
  | { type: "SET_EFFORT"; effort: "low" | "medium" | "high" | "max" }
  | { type: "SET_MODEL"; model: string }
  | {
      type: "ASK_QUESTION_SHOW";
      questions: ParsedQuestion[];
      resolve: (answers: Record<string, string> | null) => void;
    }
  | { type: "ASK_QUESTION_DONE" };

function reducer(state: AppState, action: Action): AppState {
  const assistantMsg = (content: string): MessageData => ({
    role: "assistant",
    content,
    agentName: state.agentName,
  });

  const flushPrevious = (): MessageData[] =>
    state.lastResponse !== null ? [...state.messages, assistantMsg(state.lastResponse)] : state.messages;

  switch (action.type) {
    case "ADD_USER_MESSAGE":
      return {
        ...state,
        messages: [...flushPrevious(), { role: "user", content: action.content }],
        lastResponse: null,
        error: null,
      };
    case "ADD_SYSTEM_MESSAGE":
      return {
        ...state,
        messages: [...flushPrevious(), { role: "system", content: action.content }],
        lastResponse: null,
      };
    case "STREAM_START":
      return {
        ...state,
        // Flush previous dynamic response into Static before starting a new one
        messages: flushPrevious(),
        lastResponse: null,
        streamBuffer: "",
        thinkingBuffer: "",
        isStreaming: true,
        error: null,
        toolActions: [],
        subagentProgress: new Map(),
      };
    case "STREAM_TOKEN":
      return { ...state, streamBuffer: state.streamBuffer + action.token };
    case "THINKING_TOKEN":
      return { ...state, thinkingBuffer: state.thinkingBuffer + action.token };
    case "MESSAGE_COMPLETE":
      return {
        ...state,
        messages: action.rendered ? [...state.messages, assistantMsg(action.rendered)] : state.messages,
        lastResponse: null,
        streamBuffer: "",
        thinkingBuffer: "",
        isStreaming: false,
        toolActions: [],
      };
    case "TOOL_USE":
      return { ...state, toolActions: [...state.toolActions, { name: action.name }] };
    case "TOOL_USE_DETAIL": {
      if (state.toolActions.length === 0) return state;
      const updated = [...state.toolActions];
      const last = updated[updated.length - 1];
      if (last) updated[updated.length - 1] = { ...last, detail: action.detail };
      return { ...state, toolActions: updated };
    }
    case "SET_SESSION":
      return { ...state, sessionId: action.sessionId };
    case "SET_SESSION_NAME":
      return { ...state, sessionName: action.name };
    case "SET_LISTING":
      return { ...state, lastListing: action.listing };
    case "SET_ERROR":
      return { ...state, error: action.error, isStreaming: false, streamBuffer: "", thinkingBuffer: "" };
    case "RESET_INPUT":
      return { ...state, inputKey: state.inputKey + 1 };
    case "UPDATE_CONTEXT":
      return { ...state, contextTokens: action.tokens };
    case "SUBAGENT_STARTED": {
      const next = new Map(state.subagentProgress);
      next.set(action.taskId, {
        taskId: action.taskId,
        description: action.description,
        toolUses: 0,
        durationMs: 0,
        totalTokens: 0,
        status: "running",
      });
      return { ...state, subagentProgress: next };
    }
    case "SUBAGENT_PROGRESS": {
      const next = new Map(state.subagentProgress);
      const existing = next.get(action.taskId);
      if (existing) {
        next.set(action.taskId, {
          ...existing,
          toolUses: action.toolUses,
          durationMs: action.durationMs,
          totalTokens: action.totalTokens,
        });
      }
      return { ...state, subagentProgress: next };
    }
    case "SUBAGENT_DONE": {
      const next = new Map(state.subagentProgress);
      const existing = next.get(action.taskId);
      if (existing) {
        next.set(action.taskId, { ...existing, status: action.status, totalTokens: action.totalTokens });
      }
      return { ...state, subagentProgress: next };
    }
    case "SET_EFFORT":
      return { ...state, effortOverride: action.effort };
    case "SET_MODEL":
      return { ...state, modelOverride: action.model };
    case "ASK_QUESTION_SHOW":
      return {
        ...state,
        pendingQuestion: { questions: action.questions, resolve: action.resolve },
      };
    case "ASK_QUESTION_DONE":
      return { ...state, pendingQuestion: null };
  }
}

function initialMessages(banner: string, sessionId: string | null): MessageData[] {
  return [
    { role: "system", content: banner },
    { role: "system", content: `[${sessionId ? "Resuming previous session" : "New session started"}]` },
  ];
}

function ContextBar({ tokens }: { tokens: number }) {
  const pct = Math.min(100, Math.round((tokens / MAX_CONTEXT) * 100));
  const width = 16;
  const filled = Math.round((pct / 100) * width);

  let barColor: string;
  if (pct >= 75) barColor = "redBright";
  else if (pct >= 50) barColor = "yellowBright";
  else barColor = "greenBright";

  return (
    <Box>
      <Text color={barColor}>{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(width - filled)}</Text>
      <Text dimColor>
        {" "}
        {formatTokens(tokens)}/{formatTokens(MAX_CONTEXT)}
      </Text>
    </Box>
  );
}

export interface AppProps {
  initialSessionId: string | null;
  initialSessionName: string | null;
  agentContext: AgentContext;
  config: HarnessConfig;
  agentEnv?: Record<string, string>;
}

export function App({ initialSessionId, initialSessionName, agentContext, config, agentEnv = {} }: AppProps) {
  const { exit } = useApp();

  const banner = useMemo(
    () => agentBanner(agentContext.name, config.model, config.effort),
    [agentContext.name, config.model, config.effort],
  );
  const sessionDirs: SessionDirs = useMemo(
    () => ({ sessionsDir: agentContext.sessionsDir, lastSessionFile: agentContext.lastSessionFile }),
    [agentContext.sessionsDir, agentContext.lastSessionFile],
  );

  const [state, dispatch] = useReducer(reducer, {
    messages: initialMessages(banner, initialSessionId),
    streamBuffer: "",
    thinkingBuffer: "",
    isStreaming: false,
    lastResponse: null,
    sessionId: initialSessionId,
    sessionName: initialSessionName,
    lastListing: null,
    error: null,
    inputKey: 0,
    contextTokens: 0,
    toolActions: [],
    subagentProgress: new Map(),
    agentName: agentContext.name,
    effortOverride: null,
    modelOverride: null,
    pendingQuestion: null,
  });

  // Tool input accumulation for extracting details
  const toolInputRef = useRef("");
  const toolNameRef = useRef("");
  const inToolUseRef = useRef(false);

  // Command history
  const historyRef = useRef<string[]>([]);

  // Message queue — allows input while streaming
  const queueRef = useRef<string[]>([]);
  const [queueCount, setQueueCount] = useState(0);

  // Active query for interrupt support
  const activeQueryRef = useRef<Query | null>(null);
  const isStreamingRef = useRef(false);

  // Double Ctrl-C to exit
  const [ctrlCWarning, setCtrlCWarning] = useState(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useInput((input, key) => {
    // Bare escape → interrupt streaming (ignore terminal key sequences)
    if (key.escape && !input && isStreamingRef.current && activeQueryRef.current) {
      activeQueryRef.current.interrupt();
      queueRef.current = [];
      setQueueCount(0);
      return;
    }

    // Double Ctrl-C to exit
    const isCtrlC = input === "\x03" || (input === "c" && key.ctrl);
    if (!isCtrlC) return;

    if (ctrlCWarning) {
      exit();
      return;
    }

    setCtrlCWarning(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => setCtrlCWarning(false), 2000);
  });

  useEffect(() => {
    return () => {
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    };
  }, []);

  const processMessage = useCallback(
    async (trimmed: string) => {
      dispatch({ type: "ADD_USER_MESSAGE", content: trimmed });
      dispatch({ type: "STREAM_START" });
      isStreamingRef.current = true;

      try {
        const loadedInstructions: string[] = [];
        const effectiveConfig = {
          ...config,
          ...(state.effortOverride ? { effort: state.effortOverride } : {}),
          ...(state.modelOverride ? { model: state.modelOverride } : {}),
        };
        const { systemPrompt, manifest } = await buildSystemPrompt(agentContext, effectiveConfig);
        const toolFilter = manifest.frontmatter.tools ?? undefined;
        const options = buildOptions(
          agentContext,
          {
            resume: state.sessionId ?? undefined,
            systemPrompt,
            cwd: agentContext.workspaceDir,
            agentEnv,
            toolFilter,
            credentialsConfig: manifest.frontmatter.credentials ?? undefined,
            allowedDomains: manifest.frontmatter.sandbox?.allowedDomains,
            toolOperations: manifest.frontmatter.toolOperations ?? undefined,
            mcpConfigs: manifest.frontmatter.mcp,
            onInstructionsLoaded: (filePath, memoryType, loadReason) => {
              loadedInstructions.push(`  ${memoryType}  ${filePath}  (${loadReason})`);
            },
            onAskUserQuestion: (input) => {
              const questions = parseQuestions(input);
              if (questions.length === 0) {
                return Promise.resolve(null);
              }
              return new Promise<Record<string, string> | null>((resolve) => {
                dispatch({ type: "ASK_QUESTION_SHOW", questions, resolve });
              });
            },
          },
          effectiveConfig,
        );

        let responseBuffer = "";
        let activeSessionId = state.sessionId;
        let wasInterrupted = false;
        let instructionsFlushed = false;

        const q = sendMessage(trimmed, options);
        activeQueryRef.current = q;

        for await (const msg of q) {
          // Flush loaded instructions once after init phase
          if (!instructionsFlushed && loadedInstructions.length > 0 && msg.type !== "system") {
            instructionsFlushed = true;
            dispatch({
              type: "ADD_SYSTEM_MESSAGE",
              content: `[Instructions loaded]\n${loadedInstructions.join("\n")}`,
            });
          }

          const event = extractSdkEvent(msg);
          if (!event) continue;

          switch (event.kind) {
            case "init":
              activeSessionId = event.sessionId;
              dispatch({ type: "SET_SESSION", sessionId: event.sessionId });
              if (!state.sessionId) {
                const meta = createSessionMeta(event.sessionId, trimmed);
                await saveSession(sessionDirs, meta);
                dispatch({ type: "SET_SESSION_NAME", name: meta.name });
              }
              break;

            case "message_start":
              dispatch({ type: "UPDATE_CONTEXT", tokens: totalInputTokens(event.usage) });
              break;

            case "tool_use_start":
              dispatch({ type: "TOOL_USE", name: event.toolName });
              toolNameRef.current = event.toolName;
              toolInputRef.current = "";
              inToolUseRef.current = true;
              break;

            case "tool_input_delta":
              if (inToolUseRef.current) {
                toolInputRef.current += event.partialJson;
              }
              break;

            case "tool_block_stop":
              if (inToolUseRef.current) {
                inToolUseRef.current = false;
                try {
                  const input = JSON.parse(toolInputRef.current);
                  const detail = extractToolDetail(toolNameRef.current, input);
                  if (detail) dispatch({ type: "TOOL_USE_DETAIL", detail });
                } catch {}
              }
              break;

            case "thinking_token":
              dispatch({ type: "THINKING_TOKEN", token: event.text });
              break;

            case "text_block_start":
              if (responseBuffer.length > 0) {
                responseBuffer += "\n\n";
                dispatch({ type: "STREAM_TOKEN", token: "\n\n" });
              }
              break;

            case "text_token":
              responseBuffer += event.text;
              dispatch({ type: "STREAM_TOKEN", token: event.text });
              break;

            case "subagent_started":
              dispatch({ type: "SUBAGENT_STARTED", taskId: event.taskId, description: event.description });
              break;

            case "subagent_progress":
              dispatch({
                type: "SUBAGENT_PROGRESS",
                taskId: event.taskId,
                toolUses: event.toolUses,
                durationMs: event.durationMs,
                totalTokens: event.totalTokens,
              });
              break;

            case "subagent_done":
              dispatch({
                type: "SUBAGENT_DONE",
                taskId: event.taskId,
                status: event.status as "completed" | "failed" | "stopped",
                summary: event.summary,
                totalTokens: event.totalTokens,
              });
              break;

            case "assistant": {
              const usage = event.usage;
              if (usage) {
                dispatch({ type: "UPDATE_CONTEXT", tokens: totalInputTokens(usage) });
              }
              if (!responseBuffer && event.textContent) {
                responseBuffer = event.textContent;
              }
              break;
            }

            case "result":
              wasInterrupted = event.isInterrupted;
              break;
          }
        }

        activeQueryRef.current = null;
        isStreamingRef.current = false;

        const suffix = wasInterrupted ? "\n\n[interrupted]" : "";
        if (responseBuffer) {
          dispatch({ type: "MESSAGE_COMPLETE", rendered: renderMarkdown(responseBuffer) + suffix });
        } else {
          dispatch({ type: "MESSAGE_COMPLETE", rendered: suffix });
        }

        if (activeSessionId) {
          await touchSession(sessionDirs, activeSessionId);
        }
      } catch (err: any) {
        activeQueryRef.current = null;
        isStreamingRef.current = false;
        dispatch({ type: "SET_ERROR", error: formatErrorShort(err) });
      }
    },
    [state.sessionId, state.effortOverride, state.modelOverride, agentContext, config, sessionDirs, agentEnv],
  );

  const handleSubmit = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;

      dispatch({ type: "RESET_INPUT" });

      // Commands always execute immediately
      if (trimmed === "/quit" || trimmed === "/exit") {
        exit();
        return;
      }

      if (trimmed === "/new") {
        dispatch({ type: "SET_SESSION", sessionId: null });
        dispatch({ type: "SET_SESSION_NAME", name: null });
        dispatch({ type: "ADD_SYSTEM_MESSAGE", content: "[New session started]" });
        return;
      }

      if (trimmed === "/sessions") {
        const sessions = await listSessions(sessionDirs);
        const top20 = sessions.slice(0, 20);
        dispatch({ type: "SET_LISTING", listing: top20 });
        if (top20.length === 0) {
          dispatch({ type: "ADD_SYSTEM_MESSAGE", content: "[No sessions found]" });
        } else {
          const lines = top20.map((s, i) => {
            const marker = s.id === state.sessionId ? " *" : "";
            return `  #${i + 1}  ${s.name}  (${relativeTime(s.lastUsedAt)})${marker}`;
          });
          dispatch({
            type: "ADD_SYSTEM_MESSAGE",
            content: `[Sessions]\n${lines.join("\n")}`,
          });
        }
        return;
      }

      if (trimmed.startsWith("/resume")) {
        const arg = trimmed.slice("/resume".length).trim();
        let targetId: string | null = null;
        let targetName: string | null = null;

        if (!arg) {
          targetId = await getLastSessionId(sessionDirs);
        } else if (arg.startsWith("#")) {
          const num = parseInt(arg.slice(1), 10);
          if (state.lastListing && num >= 1 && num <= state.lastListing.length) {
            const session = state.lastListing[num - 1];
            targetId = session?.id ?? null;
            targetName = session?.name ?? null;
          } else {
            dispatch({
              type: "ADD_SYSTEM_MESSAGE",
              content: `[Invalid session number. Run /sessions first]`,
            });
            return;
          }
        } else {
          const sessions = await listSessions(sessionDirs);
          const match = findSessionByName(arg, sessions);
          if (match) {
            targetId = match.id;
            targetName = match.name;
          } else {
            dispatch({
              type: "ADD_SYSTEM_MESSAGE",
              content: `[No session matching "${arg}"]`,
            });
            return;
          }
        }

        if (!targetId) {
          dispatch({ type: "ADD_SYSTEM_MESSAGE", content: "[No previous session found]" });
          return;
        }

        if (!targetName) {
          const meta = await loadSession(sessionDirs, targetId);
          targetName = meta?.name ?? null;
        }

        dispatch({ type: "SET_SESSION", sessionId: targetId });
        dispatch({ type: "SET_SESSION_NAME", name: targetName });
        dispatch({
          type: "ADD_SYSTEM_MESSAGE",
          content: targetName ? `[Resuming: ${targetName}]` : "[Resuming previous session]",
        });
        return;
      }

      if (trimmed.startsWith("/name")) {
        const newName = trimmed.slice("/name".length).trim();
        if (!newName) {
          dispatch({ type: "ADD_SYSTEM_MESSAGE", content: "[Usage: /name <text>]" });
          return;
        }
        if (!state.sessionId) {
          dispatch({ type: "ADD_SYSTEM_MESSAGE", content: "[No active session to rename]" });
          return;
        }
        await renameSession(sessionDirs, state.sessionId, newName);
        dispatch({ type: "SET_SESSION_NAME", name: newName });
        dispatch({ type: "ADD_SYSTEM_MESSAGE", content: `[Session renamed: ${newName}]` });
        return;
      }

      if (trimmed === "/help") {
        const currentEffort = state.effortOverride ?? config.effort;
        const currentModel = state.modelOverride ?? config.model;
        const lines = [
          "[Commands]",
          "",
          "  /help                     — show this help",
          "  /effort [low|med|high|max] — show or set effort level",
          "  /model [model-id]         — show or set model",
          "  /sessions                 — list recent sessions",
          "  /resume [name|#N]         — resume a session",
          "  /name <text>              — rename current session",
          "  /new                      — start fresh session",
          "  /quit                     — exit",
          "",
          "[Keyboard shortcuts]",
          "",
          "  Enter       — send message",
          "  Ctrl+J      — insert newline",
          "  Ctrl+G      — open external editor",
          "  Escape      — interrupt streaming / clear input",
          "  Ctrl+C ×2   — exit",
          "",
          `[Current]  model: ${currentModel}  effort: ${currentEffort}`,
        ];
        dispatch({ type: "ADD_SYSTEM_MESSAGE", content: lines.join("\n") });
        return;
      }

      if (trimmed.startsWith("/effort")) {
        const arg = trimmed.slice("/effort".length).trim().toLowerCase();
        const currentEffort = state.effortOverride ?? config.effort;

        if (!arg) {
          dispatch({
            type: "ADD_SYSTEM_MESSAGE",
            content: `[Effort: ${currentEffort}  (options: low, medium, high, max)]`,
          });
          return;
        }

        const normalized = arg === "med" ? "medium" : arg;
        if (!["low", "medium", "high", "max"].includes(normalized)) {
          dispatch({
            type: "ADD_SYSTEM_MESSAGE",
            content: `[Invalid effort level "${arg}". Options: low, medium, high, max]`,
          });
          return;
        }

        dispatch({ type: "SET_EFFORT", effort: normalized as "low" | "medium" | "high" | "max" });
        dispatch({ type: "ADD_SYSTEM_MESSAGE", content: `[Effort set to: ${normalized}]` });
        return;
      }

      if (trimmed.startsWith("/model")) {
        const arg = trimmed.slice("/model".length).trim();
        const currentModel = state.modelOverride ?? config.model;

        if (!arg) {
          dispatch({ type: "ADD_SYSTEM_MESSAGE", content: `[Model: ${currentModel}]` });
          return;
        }

        dispatch({ type: "SET_MODEL", model: arg });
        dispatch({ type: "ADD_SYSTEM_MESSAGE", content: `[Model set to: ${arg}]` });
        return;
      }

      // Non-command message: add to history
      historyRef.current.push(trimmed);

      // If streaming, queue the message instead of sending
      if (isStreamingRef.current) {
        queueRef.current.push(trimmed);
        setQueueCount(queueRef.current.length);
        dispatch({ type: "ADD_USER_MESSAGE", content: trimmed });
        return;
      }

      // Process message, then drain the queue
      await processMessage(trimmed);
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift() as string;
        setQueueCount(queueRef.current.length);
        await processMessage(next);
      }
      setQueueCount(0);
    },
    [
      state.sessionId,
      state.lastListing,
      exit,
      sessionDirs,
      processMessage,
      state.effortOverride,
      config.effort,
      state.modelOverride,
      config.model,
    ],
  );

  const showSessionLine = ctrlCWarning || queueCount > 0;

  return (
    <Box flexDirection="column">
      <ChatHistory messages={state.messages} />

      {state.isStreaming && (
        <StreamingResponse
          text={state.streamBuffer}
          thinking={state.thinkingBuffer}
          toolActions={state.toolActions}
          subagentProgress={state.subagentProgress}
          agentName={agentContext.name}
        />
      )}

      {state.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>
        {state.pendingQuestion ? (
          <QuestionSelector
            questions={state.pendingQuestion.questions}
            onComplete={(answers) => {
              state.pendingQuestion?.resolve(answers);
              dispatch({ type: "ASK_QUESTION_DONE" });
            }}
            onDismiss={() => {
              state.pendingQuestion?.resolve(null);
              dispatch({ type: "ASK_QUESTION_DONE" });
            }}
          />
        ) : (
          <InputArea
            isDisabled={false}
            isStreaming={state.isStreaming}
            onSubmit={handleSubmit}
            resetKey={state.inputKey}
            history={historyRef.current}
          />
        )}
        <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>
        <Box justifyContent="space-between">
          <Box>
            <Text color="magenta"> {agentContext.name}</Text>
            <Text dimColor> · </Text>
            <Text dimColor>{state.modelOverride ?? config.model}</Text>
            <Text dimColor> · </Text>
            <Text color={(state.effortOverride ?? config.effort) === "max" ? "green" : "gray"}>
              {state.effortOverride ?? config.effort}
            </Text>
            {process.env.HARNESS_SANDBOXED && <Text dimColor> · 🔒</Text>}
          </Box>
          <ContextBar tokens={state.contextTokens} />
        </Box>
        {showSessionLine && (
          <Box>
            {ctrlCWarning ? (
              <Text color="yellow"> Press Ctrl-C again to exit</Text>
            ) : (
              <Box>{queueCount > 0 && <Text color="yellow"> ({queueCount} queued)</Text>}</Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
