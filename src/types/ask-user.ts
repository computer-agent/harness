export interface ParsedQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export function parseQuestions(input: Record<string, unknown>): ParsedQuestion[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) return [];

  return questions.map((q: any) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    options: Array.isArray(q.options)
      ? q.options.map((o: any) => ({
          label: String(o.label ?? ""),
          description: String(o.description ?? ""),
          ...(o.preview ? { preview: String(o.preview) } : {}),
        }))
      : [],
    multiSelect: Boolean(q.multiSelect),
  }));
}
