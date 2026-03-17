import { Check, Copy } from "lucide-react";
import { type ComponentProps, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";
import { ToolCallBlock } from "./ToolCallBlock";

export function MessageBubble({ message }: { message: ChatMessage }) {
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
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ code: CodeBlock }}>
              {message.content}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

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
