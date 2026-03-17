import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AgentInfo } from "@/types";

interface MentionAutocompleteProps {
  agents: AgentInfo[];
  filter: string;
  onSelect: (agent: AgentInfo) => void;
  onDismiss: () => void;
  visible: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

const MAX_VISIBLE = 5;

export function MentionAutocomplete({
  agents,
  filter,
  onSelect,
  onDismiss: _onDismiss,
  visible,
  activeIndex,
  onActiveIndexChange,
}: MentionAutocompleteProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = filterAgents(agents, filter);

  // Scroll active item into view
  useEffect(() => {
    if (!visible || activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible]);

  const handleItemClick = useCallback(
    (agent: AgentInfo) => {
      onSelect(agent);
    },
    [onSelect],
  );

  if (!visible) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-50 mb-1 sm:left-auto sm:right-auto sm:min-w-64 sm:max-w-sm"
      role="presentation"
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={t("mentions.agentList")}
        className="overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
        style={{ maxHeight: `${MAX_VISIBLE * 48}px` }}
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">{t("mentions.noAgents")}</div>
        ) : (
          filtered.map((agent, index) => (
            <div
              key={agent.id}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors ${
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent textarea blur
                handleItemClick(agent);
              }}
              onMouseEnter={() => onActiveIndexChange(index)}
            >
              <span className="shrink-0 text-base" aria-hidden="true">
                {agent.icon ?? "\u{1F916}"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{agent.name}</div>
                {agent.description && <div className="truncate text-xs text-muted-foreground">{agent.description}</div>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Returns the filtered agent list for a given mention filter string. */
export function filterAgents(agents: AgentInfo[], filter: string): AgentInfo[] {
  return agents.filter(
    (a) => a.name.toLowerCase().includes(filter.toLowerCase()) || a.id.toLowerCase().includes(filter.toLowerCase()),
  );
}
