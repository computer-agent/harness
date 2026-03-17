import { Check, Copy } from "lucide-react";
import { Component, type ComponentProps, type ErrorInfo, memo, type ReactNode, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";
import { ToolCallBlock } from "./ToolCallBlock";

// FIX-07: Error boundary to prevent markdown parse failures from crashing the chat UI
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackContent: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallbackContent: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Markdown rendering failed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return <pre className="whitespace-pre-wrap break-words text-sm">{this.props.fallbackContent}</pre>;
    }
    return this.props.children;
  }
}

// FIX-16: Memoize to avoid re-rendering every bubble when a new message arrives.
// ToolCallBlock is intentionally NOT memoized — it has dynamic internal state.
export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end px-4 py-1" data-role="user">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm text-white sm:max-w-[85%]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-4 py-1" data-role="assistant">
      <div className="max-w-[80%] space-y-0.5 rounded-2xl rounded-bl-sm bg-secondary px-4 py-2.5 text-sm sm:max-w-[90%]">
        {/* Render tool calls inline */}
        {message.toolCalls?.map((tc) => (
          <ToolCallBlock key={tc.id} toolCall={tc} />
        ))}

        {/* Markdown content */}
        {message.content && (
          <div className={cn("prose dark:prose-invert prose-sm max-w-none", message.isStreaming && "streaming-cursor")}>
            <MarkdownErrorBoundary fallbackContent={message.content}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                skipHtml
                components={{ code: CodeBlock }}
              >
                {message.content}
              </Markdown>
            </MarkdownErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
});

function CodeBlock({ children, className, ...props }: ComponentProps<"code">) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isInline = !className;

  const handleCopy = useCallback(() => {
    const text = typeof children === "string" ? children : "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [children]);

  if (isInline) {
    return (
      <code className="rounded bg-card px-1 py-0.5 text-xs" {...props}>
        {children}
      </code>
    );
  }

  const lang = className?.replace("language-", "") ?? "";

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 sm:opacity-0 transition-opacity sm:group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("chat.copyCode")}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? t("chat.codeCopied") : t("chat.copyCode")}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-4">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}
