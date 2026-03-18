import assert from "node:assert";
import { describe, it } from "node:test";
import { parseQuestions } from "./ask-user.js";

describe("parseQuestions", () => {
  it("returns empty array when input has no questions key", () => {
    assert.deepStrictEqual(parseQuestions({}), []);
  });

  it("returns empty array when questions is not an array", () => {
    assert.deepStrictEqual(parseQuestions({ questions: "not an array" }), []);
  });

  it("returns empty array when questions is null", () => {
    assert.deepStrictEqual(parseQuestions({ questions: null }), []);
  });

  it("parses a single question with options", () => {
    const input = {
      questions: [
        {
          question: "Pick one",
          header: "Header",
          options: [{ label: "A", description: "Option A" }],
          multiSelect: false,
        },
      ],
    };
    const result = parseQuestions(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.question, "Pick one");
    assert.strictEqual(result[0]?.header, "Header");
    assert.strictEqual(result[0]?.options.length, 1);
    assert.strictEqual(result[0]?.options[0]?.label, "A");
    assert.strictEqual(result[0]?.options[0]?.description, "Option A");
    assert.strictEqual(result[0]?.multiSelect, false);
  });

  it("parses multiple questions", () => {
    const input = {
      questions: [
        { question: "Q1", header: "H1", options: [], multiSelect: false },
        { question: "Q2", header: "H2", options: [], multiSelect: true },
      ],
    };
    const result = parseQuestions(input);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]?.question, "Q1");
    assert.strictEqual(result[1]?.question, "Q2");
  });

  it("handles missing optional fields with defaults", () => {
    const result = parseQuestions({ questions: [{}] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.question, "");
    assert.strictEqual(result[0]?.header, "");
    assert.deepStrictEqual(result[0]?.options, []);
    assert.strictEqual(result[0]?.multiSelect, false);
  });

  it("coerces non-string fields to strings", () => {
    const result = parseQuestions({ questions: [{ question: 123 }] });
    assert.strictEqual(result[0]?.question, "123");
  });

  it("handles options that are not arrays", () => {
    const result = parseQuestions({ questions: [{ options: "not-array" }] });
    assert.deepStrictEqual(result[0]?.options, []);
  });

  it("handles question with no options", () => {
    const result = parseQuestions({ questions: [{ question: "Q" }] });
    assert.deepStrictEqual(result[0]?.options, []);
  });

  it("preserves preview field when present", () => {
    const input = {
      questions: [
        {
          question: "Q",
          options: [{ label: "A", description: "D", preview: "some preview" }],
        },
      ],
    };
    const result = parseQuestions(input);
    assert.strictEqual(result[0]?.options[0]?.preview, "some preview");
  });

  it("omits preview field when absent", () => {
    const input = {
      questions: [
        {
          question: "Q",
          options: [{ label: "A", description: "D" }],
        },
      ],
    };
    const result = parseQuestions(input);
    const opt0 = result[0]?.options[0] ?? {};
    assert.strictEqual("preview" in opt0, false);
  });

  it("omits preview field when falsy empty string", () => {
    const input = {
      questions: [
        {
          question: "Q",
          options: [{ label: "A", description: "D", preview: "" }],
        },
      ],
    };
    const result = parseQuestions(input);
    const opt0 = result[0]?.options[0] ?? {};
    assert.strictEqual("preview" in opt0, false);
  });

  it("handles multiSelect boolean coercion", () => {
    const r0 = parseQuestions({ questions: [{ multiSelect: 0 }] });
    assert.strictEqual(r0[0]?.multiSelect, false);

    const r1 = parseQuestions({ questions: [{ multiSelect: 1 }] });
    assert.strictEqual(r1[0]?.multiSelect, true);
  });
});
