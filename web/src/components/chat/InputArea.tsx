import { Mic, MicOff, SendHorizontal, Square } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useVoiceInput } from "@/hooks/useVoiceInput";

const waveformBarIds = ["bar-a", "bar-b", "bar-c", "bar-d", "bar-e", "bar-f", "bar-g", "bar-h"];

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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    textareaRef.current?.focus();
  }, [value, onSend]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    }
  };

  return (
    <div className="safe-area-bottom border-t border-border bg-background p-3">
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
          value={voice.isListening ? value + voice.interimTranscript : value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("chat.placeholder")}
          disabled={disabled}
          rows={1}
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
