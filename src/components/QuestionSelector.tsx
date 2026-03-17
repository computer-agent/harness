import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { ParsedQuestion } from "../types/ask-user.js";

interface QuestionSelectorProps {
  questions: ParsedQuestion[];
  onComplete: (answers: Record<string, string>) => void;
  onDismiss: () => void;
}

export function QuestionSelector({ questions, onComplete, onDismiss }: QuestionSelectorProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [isOtherMode, setIsOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");

  const current = questions[questionIndex];

  // Options = agent-provided + auto-appended "Other..."
  const allOptions = current ? [...current.options, { label: "Other...", description: "Type a custom answer" }] : [];
  const otherIndex = allOptions.length - 1;

  function commitAnswer(answer: string) {
    if (!current) return;
    const next = { ...answers, [current.question]: answer };
    if (questionIndex + 1 < questions.length) {
      setAnswers(next);
      setQuestionIndex(questionIndex + 1);
      setSelectedIndex(0);
      setMultiSelected(new Set());
      setIsOtherMode(false);
      setOtherText("");
    } else {
      onComplete(next);
    }
  }

  useInput((input, key) => {
    if (!current) return;
    if (key.escape) {
      if (isOtherMode) {
        setIsOtherMode(false);
        setOtherText("");
        return;
      }
      onDismiss();
      return;
    }

    // Free-text "Other" mode
    if (isOtherMode) {
      if (key.return) {
        if (otherText.trim()) {
          commitAnswer(otherText.trim());
        }
        return;
      }
      if (key.backspace || key.delete) {
        setOtherText(otherText.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setOtherText(otherText + input);
      }
      return;
    }

    // Navigation
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(Math.min(allOptions.length - 1, selectedIndex + 1));
      return;
    }

    // Multi-select: Space toggles
    if (input === " " && current.multiSelect && selectedIndex !== otherIndex) {
      const next = new Set(multiSelected);
      if (next.has(selectedIndex)) {
        next.delete(selectedIndex);
      } else {
        next.add(selectedIndex);
      }
      setMultiSelected(next);
      return;
    }

    // Enter to confirm
    if (key.return) {
      if (selectedIndex === otherIndex) {
        setIsOtherMode(true);
        setOtherText("");
        return;
      }
      if (current.multiSelect) {
        // If nothing toggled yet, select the focused item
        const selected = multiSelected.size > 0 ? multiSelected : new Set([selectedIndex]);
        const labels = [...selected].sort().map((i) => allOptions[i].label);
        commitAnswer(labels.join(", "));
      } else {
        commitAnswer(allOptions[selectedIndex].label);
      }
    }
  });

  if (!current) return null;

  const progress = questions.length > 1 ? ` (${questionIndex + 1}/${questions.length})` : "";

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1} paddingBottom={1}>
      <Box>
        <Text color="cyan" bold>
          [{current.header}]
        </Text>
        <Text> {current.question}</Text>
        {progress && <Text dimColor>{progress}</Text>}
      </Box>
      <Text> </Text>

      {isOtherMode ? (
        <Box>
          <Text color="cyan" bold>
            {"  > "}
          </Text>
          <Text>{otherText}</Text>
          <Text dimColor>▌</Text>
        </Box>
      ) : (
        allOptions.map((opt, i) => {
          const focused = i === selectedIndex;
          const checked = current.multiSelect && multiSelected.has(i);
          const prefix = current.multiSelect
            ? checked
              ? "  [x] "
              : "  [ ] "
            : focused
              ? "  > "
              : "    ";

          return (
            <Box key={opt.label} flexDirection="row">
              <Text color={focused ? "cyan" : undefined} bold={focused}>
                {prefix}
                {opt.label}
              </Text>
              {opt.description && i !== otherIndex && (
                <Text dimColor> — {opt.description}</Text>
              )}
            </Box>
          );
        })
      )}

      <Text> </Text>
      <Text dimColor>
        {isOtherMode
          ? "  [Enter] submit  [Esc] back"
          : current.multiSelect
            ? "  [Up/Down] navigate  [Space] toggle  [Enter] confirm  [Esc] dismiss"
            : "  [Up/Down] navigate  [Enter] select  [Esc] dismiss"}
      </Text>
    </Box>
  );
}
