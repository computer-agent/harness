import { Mic, MicOff, SendHorizontal, Square } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAgentRoster } from "@/hooks/useAgentRoster";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { AgentInfo } from "@/types";
import { filterAgents, MentionAutocomplete } from "./MentionAutocomplete";

const waveformBarIds = ["bar-a", "bar-b", "bar-c", "bar-d", "bar-e", "bar-f", "bar-g", "bar-h"];

/** Matches `@` at start of input or after whitespace, capturing the partial name typed so far. */
const MENTION_REGEX = /(?:^|\s)@(\w*)$/;

interface InputAreaProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function InputArea({ onSend, onInterrupt, isStreaming, disabled }: InputAreaProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voice = useVoiceInput();
  const { agents } = useAgentRoster();

  // Mention autocomplete state
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`; // max 6 rows ~ 144px
  }, [value]);

  // Insert voice transcript
  useEffect(() => {
    if (voice.transcript) {
      setValue((prev) => prev + voice.transcript);
    }
  }, [voice.transcript]);

  // Detect @mention pattern on value/cursor change
  const detectMention = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);
    const match = MENTION_REGEX.exec(textBeforeCursor);
    if (match) {
      setMentionFilter(match[1]);
      setMentionVisible(true);
      setMentionActiveIndex(0);
    } else {
      setMentionVisible(false);
    }
  }, [value]);

  // Re-check mention on every value change
  useEffect(() => {
    detectMention();
  }, [detectMention]);

  const handleSelectAgent = useCallback(
    (agent: AgentInfo) => {
      const el = textareaRef.current;
      if (!el) return;
      const cursorPos = el.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);
      const match = MENTION_REGEX.exec(textBeforeCursor);
      if (!match) return;

      // Replace the @partial with @agentid + trailing space
      const mentionStart = match.index + (match[0].startsWith(" ") || match[0].startsWith("\n") ? 1 : 0);
      const before = value.slice(0, mentionStart);
      const after = value.slice(cursorPos);
      const insertion = `@${agent.id} `;
      const newValue = before + insertion + after;
      setValue(newValue);
      setMentionVisible(false);

      // Restore cursor position after React re-render
      const newCursorPos = before.length + insertion.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(newCursorPos, newCursorPos);
      });
    },
    [value],
  );

  const dismissMention = useCallback(() => {
    setMentionVisible(false);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    setMentionVisible(false);
    textareaRef.current?.focus();
  }, [value, onSend]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // When mention autocomplete is visible, intercept navigation keys
    if (mentionVisible) {
      const filtered = filterAgents(agents, mentionFilter);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActiveIndex((prev) => (prev + 1) % Math.max(filtered.length, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActiveIndex((prev) => (prev - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (filtered.length > 0) {
          e.preventDefault();
          handleSelectAgent(filtered[mentionActiveIndex] ?? filtered[0]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionVisible(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    }
  };

  return (
    <div className="safe-area-bottom relative border-t border-border bg-background p-3">
      {/* Mention autocomplete dropdown */}
      <MentionAutocomplete
        agents={agents}
        filter={mentionFilter}
        onSelect={handleSelectAgent}
        onDismiss={dismissMention}
        visible={mentionVisible}
        activeIndex={mentionActiveIndex}
        onActiveIndexChange={setMentionActiveIndex}
      />

      {/* Voice waveform placeholder */}
      {voice.isListening && (
        <div className="mb-2 flex items-center justify-center gap-0.5" aria-hidden="true">
          {waveformBarIds.map((barId) => (
            <div
              key={barId}
              className="w-1 rounded-full bg-red-500"
              style={{
                height: `${8 + Math.random() * 16}px`,
                animation: `pulse-dot ${0.3 + Math.random() * 0.4}s ease-in-out infinite alternate`,
              }}
            />
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">
          {t("chat.placeholder")}
        </label>
        <textarea
          id="chat-input"
          ref={textareaRef}
          role="combobox"
          value={voice.isListening ? value + voice.interimTranscript : value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("chat.placeholder")}
          disabled={disabled}
          rows={1}
          aria-expanded={mentionVisible}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          className="flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />

        {/* Voice button */}
        {voice.isSupported && (
          <Button
            variant="ghost"
            size="icon"
            onClick={voice.isListening ? voice.stopListening : voice.startListening}
            disabled={isStreaming}
            className={voice.isListening ? "text-red-500" : ""}
            aria-label={voice.isListening ? t("voice.stopListening") : t("voice.startListening")}
          >
            {voice.isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
        )}

        {/* Send / Stop button */}
        {isStreaming ? (
          <Button variant="ghost" size="icon" onClick={onInterrupt} aria-label={t("chat.stop")}>
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            aria-label={t("chat.send")}
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
